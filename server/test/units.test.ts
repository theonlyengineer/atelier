import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ATELIER_HOME = mkdtempSync(join(tmpdir(), 'atelier-test-'))

const { interpolate } = await import('../src/core/runner.ts')
const { probeDimensions, store, read } = await import('../src/core/assets.ts')
const repo = await import('../src/db/repo.ts')

test('interpolate fills placeholders from inputs', () => {
  assert.equal(interpolate('a {{x}} c', { x: 'b' }), 'a b c')
  assert.equal(interpolate('{{ x }}', { x: 'b' }), 'b')
  assert.equal(interpolate('{{a}}-{{b}}', { a: '1', b: '2' }), '1-2')
})

test('interpolate leaves unknown placeholders visible rather than blanking them', () => {
  // A typo that silently becomes an empty prompt is far worse than one that
  // shows up in the browser as literal text.
  assert.equal(interpolate('{{nope}}', { x: 'b' }), '{{nope}}')
})

test('probeDimensions reads a PNG header', () => {
  const png = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0)
  png.writeUInt32BE(1024, 16)
  png.writeUInt32BE(768, 20)
  assert.deepEqual(probeDimensions(png), { width: 1024, height: 768 })
})

test('probeDimensions reads a GIF header', () => {
  const gif = Buffer.alloc(12)
  gif.write('GIF89a', 0)
  gif.writeUInt16LE(300, 6)
  gif.writeUInt16LE(200, 8)
  assert.deepEqual(probeDimensions(gif), { width: 300, height: 200 })
})

test('probeDimensions returns null for something that is not an image', () => {
  assert.equal(probeDimensions(Buffer.from('hello world')), null)
})

test('store is content-addressed: same bytes, one blob, two assets', () => {
  const data = Buffer.from('identical bytes')
  const a = store(data, { mime: 'image/png', prompt: 'first' })
  const b = store(data, { mime: 'image/png', prompt: 'second' })
  assert.equal(a.sha256, b.sha256)
  assert.notEqual(a.id, b.id)
  // Both prompts survive, because the question "what produced this" has two
  // different answers.
  assert.equal(a.prompt, 'first')
  assert.equal(b.prompt, 'second')
  assert.deepEqual(read(a), data)
})

test('a workflow round-trips through the database', () => {
  const saved = repo.saveWorkflow({
    name: 'w1',
    description: 'test',
    status: 'active',
    origins: ['https://example.test'],
    profileId: null,
    inputs: [{ name: 'prompt', description: 'p', required: true }],
    steps: [{ id: 's1', kind: 'click', selectors: [], timeoutMs: 1000 }],
    produces: 'image',
  })
  const found = repo.getWorkflowByName('w1')
  assert.equal(found?.id, saved.id)
  assert.deepEqual(found?.origins, ['https://example.test'])
  assert.equal(found?.steps.length, 1)
})

test('saving the same workflow name updates rather than duplicating', () => {
  const first = repo.saveWorkflow({
    name: 'w2', description: 'a', status: 'draft', origins: ['https://x.test'],
    profileId: null, inputs: [], steps: [], produces: 'none',
  })
  const second = repo.saveWorkflow({
    id: first.id,
    name: 'w2', description: 'b', status: 'active', origins: ['https://x.test'],
    profileId: null, inputs: [], steps: [], produces: 'image',
  })
  assert.equal(first.id, second.id)
  assert.equal(repo.getWorkflowByName('w2')?.description, 'b')
  assert.equal(repo.listWorkflows().filter((w) => w.name === 'w2').length, 1)
})

test('a job records its step position and blocked reason', () => {
  const w = repo.saveWorkflow({
    name: 'w3', description: '', status: 'active', origins: ['https://x.test'],
    profileId: null, inputs: [], steps: [], produces: 'none',
  })
  const job = repo.createJob(w.id, { prompt: 'x' }, 4)
  repo.updateJob(job.id, { status: 'blocked', stepIndex: 2, blockedReason: 'sign in' })
  const after = repo.getJob(job.id)!
  assert.equal(after.status, 'blocked')
  assert.equal(after.stepIndex, 2)
  assert.equal(after.blockedReason, 'sign in')
  assert.equal(after.workflowName, 'w3')
})

/* ------------------------------------------------------------ escalation */

test('a job parked for a long time is mentioned again, but not every minute', async () => {
  // One notification is all a parked job used to get. If the browser was shut,
  // or the toast was swiped past, nobody was told again and the job waited
  // forever — which reads to the human as Atelier having lost their work.
  const { Runner } = await import('../src/core/runner.ts')

  const said: string[] = []
  const runner = new Runner({
    hub: { onMessage: () => {}, clientFor: () => null, send: () => {} } as never,
    onChange: () => {},
    notify: (title, body) => said.push(`${title}|${body}`),
  })

  const wf = repo.saveWorkflow({
    name: 'parked-workflow',
    description: '',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    steps: [{ id: 's', kind: 'click', selectors: [{ strategy: 'id', value: '#a', score: 92 }], timeoutMs: 1000 }],
  } as never)

  const job = repo.createJob(wf.id, {}, 1)
  repo.updateJob(job.id, { status: 'blocked', blockedReason: 'Sign in first.' })

  // Other tests in this file leave jobs behind, so everything here is scoped to
  // this one rather than to the whole table.
  const mine = (ids: string[]) => ids.filter((id) => id === job.id)
  const aboutMine = () => said.filter((s) => s.includes('parked-workflow')).length

  const now = Date.now()
  assert.deepEqual(mine(runner.escalateStaleBlocks(15 * 60 * 1000, now)), [], 'not yet — it has only just parked')
  assert.equal(aboutMine(), 0)

  const later = now + 16 * 60 * 1000
  assert.deepEqual(mine(runner.escalateStaleBlocks(15 * 60 * 1000, later)), [job.id])
  assert.equal(aboutMine(), 1)
  assert.match(said.find((s) => s.includes('parked-workflow'))!, /still waiting/)
  assert.match(said.find((s) => s.includes('parked-workflow'))!, /Sign in first/)

  // A nag that repeats every sweep is noise, and noise gets muted.
  assert.deepEqual(mine(runner.escalateStaleBlocks(15 * 60 * 1000, later + 60_000)), [])
  assert.equal(aboutMine(), 1)

  // But it does come back round.
  assert.deepEqual(mine(runner.escalateStaleBlocks(15 * 60 * 1000, later + 16 * 60 * 1000)), [job.id])
  assert.equal(aboutMine(), 2)
})

test('a job that is not blocked is never nagged about', async () => {
  const { Runner } = await import('../src/core/runner.ts')
  const said: string[] = []
  const runner = new Runner({
    hub: { onMessage: () => {}, clientFor: () => null, send: () => {} } as never,
    onChange: () => {},
    notify: (title, body) => said.push(`${title}|${body}`),
  })

  const wf = repo.saveWorkflow({
    name: 'finished-workflow',
    description: '',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    steps: [{ id: 's', kind: 'click', selectors: [{ strategy: 'id', value: '#a', score: 92 }], timeoutMs: 1000 }],
  } as never)
  const job = repo.createJob(wf.id, {}, 1)
  repo.updateJob(job.id, { status: 'done' })

  const nagged = runner.escalateStaleBlocks(0, Date.now() + 10 ** 9)
  assert.equal(nagged.includes(job.id), false)
  assert.equal(said.filter((s) => s.includes('finished-workflow')).length, 0)
})

/* ------------------------------------------------------- route classification */

test('read-only routes are the exception; anything else announces a change', async () => {
  // A route that mutates and does not announce it is a control that silently
  // does nothing. Delete and Activate both worked and neither refreshed the
  // dashboard, which sat on stale data until the 25-second heartbeat.
  const { mutates } = await import('../src/http/api.ts')

  for (const quiet of [
    '/api/workflows.list',
    '/api/workflows.get',
    '/api/workflows.health',
    '/api/jobs.list',
    '/api/jobs.status',
    '/api/assets.list',
    '/api/drafts.list',
    '/api/drafts.get',
  ]) {
    assert.equal(mutates(quiet), false, `${quiet} only reads`)
  }

  for (const loud of [
    '/api/workflows.save',
    '/api/workflows.activate',
    '/api/workflows.delete',
    '/api/workflows.replaceStep',
    '/api/workflows.removeStep',
    '/api/workflows.setStepDelay',
    '/api/workflows.setDescription',
    '/api/workflows.setStatus',
    '/api/workflows.setStepValue',
    '/api/workflows.test',
    '/api/workflows.run',
    '/api/projects.rotateToken',
    '/api/jobs.cancel',
    '/api/jobs.resume',
    '/api/drafts.delete',
    '/api/drafts.promote',
    '/api/drafts.repropose',
    '/api/assets.attach',
  ]) {
    assert.equal(mutates(loud), true, `${loud} changes something`)
  }
})

test('every route in the table is classified, so a new one cannot be forgotten', async () => {
  const { mutates, routes } = await import('../src/http/api.ts')
  // Not an assertion about the answer — an assertion that there is one, for
  // every route that exists, derived from the name rather than a hand-kept list.
  for (const path of Object.keys(routes)) {
    assert.equal(typeof mutates(path), 'boolean', `${path} must classify`)
  }
})

/* ------------------------------------------------------------ deleting */

test('deleting an asset removes the row and the file behind it', async () => {
  const assets = await import('../src/core/assets.ts')
  const { blobPath } = await import('../src/paths.ts')
  const { existsSync } = await import('node:fs')

  const a = assets.store(Buffer.from('bytes-that-only-one-asset-uses'), { mime: 'image/png' })
  assert.ok(existsSync(blobPath(a.sha256)))

  assert.equal(assets.remove(a.id), true)
  assert.equal(repo.getAsset(a.id), null)
  assert.equal(existsSync(blobPath(a.sha256)), false, 'the blob goes with the last asset holding it')
})

test('deleting one of two assets sharing a blob keeps the file', async () => {
  // Storage is content-addressed: the same image arriving twice is one file and
  // two rows. Deleting either must not pull the file out from under the other —
  // which is the whole reason this is not just a DELETE.
  const assets = await import('../src/core/assets.ts')
  const { blobPath } = await import('../src/paths.ts')
  const { existsSync } = await import('node:fs')

  const bytes = Buffer.from('bytes-shared-by-two-assets')
  const first = assets.store(bytes, { mime: 'image/png', prompt: 'first' })
  const second = assets.store(bytes, { mime: 'image/png', prompt: 'second' })
  assert.equal(first.sha256, second.sha256)

  assert.equal(assets.remove(first.id), true)
  assert.equal(repo.getAsset(first.id), null)
  assert.ok(repo.getAsset(second.id), 'the other asset survives')
  assert.ok(existsSync(blobPath(bytes && second.sha256)), 'and so does the file it needs')

  assets.remove(second.id)
  assert.equal(existsSync(blobPath(second.sha256)), false, 'gone once nothing references it')
})

test('deleting an asset that does not exist is false, not a throw', async () => {
  const assets = await import('../src/core/assets.ts')
  assert.equal(assets.remove('no-such-asset'), false)
})

test('deleting an asset leaves the job that produced it alone', async () => {
  // The asset is the output; the run is the record of what happened. Removing a
  // picture should not rewrite history.
  const assets = await import('../src/core/assets.ts')
  const wf = repo.saveWorkflow({
    name: 'delete-keeps-history',
    description: '',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'image',
    steps: [{ id: 's', kind: 'click', selectors: [{ strategy: 'id', value: '#a', score: 92 }], timeoutMs: 1000 }],
  } as never)
  const job = repo.createJob(wf.id, {}, 1)
  const a = assets.store(Buffer.from('an-output-of-a-run'), { mime: 'image/png', jobId: job.id })

  assets.remove(a.id)
  assert.ok(repo.getJob(job.id), 'the run is still there')
})

/* ------------------------------------------------ settling between steps */

/**
 * The pause a workflow takes between one step and the next.
 *
 * Not the same thing as waiting for an element: replay already retries a
 * selector until the step's own timeout, so anything that can be waited *for*
 * is handled. This is for what cannot be — a framework re-rendering, a handler
 * on the next tick, an animation finishing so a click lands where it looks like
 * it will. None of those announce themselves.
 */

test('a second is the default, the floor, and what nonsense falls back to', async () => {
  const { stepDelay, MIN_STEP_DELAY_MS } = await import('../src/db/repo.ts')
  assert.equal(MIN_STEP_DELAY_MS, 1000)
  assert.equal(stepDelay(undefined), 1000)
  assert.equal(stepDelay(null), 1000)
  assert.equal(stepDelay(0), 1000)
  assert.equal(stepDelay(-5000), 1000, 'below the floor is somebody asking for a race')
  assert.equal(stepDelay('nonsense'), 1000)
  assert.equal(stepDelay(2500), 2500)
  assert.equal(stepDelay(2500.4), 2500)
})

test('the floor holds however the value arrives', async () => {
  const repo = await import('../src/db/repo.ts')
  const wf = repo.saveWorkflow({
    name: 'delay-floor',
    description: '',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    stepDelayMs: 10,
    steps: [{ id: 's', kind: 'click', selectors: [{ strategy: 'id', value: '#a', score: 92 }], timeoutMs: 1000 }],
  } as never)
  assert.equal(wf.stepDelayMs, 1000, 'clamped on the way in')
  assert.equal(repo.setStepDelay(wf.id, 250).stepDelayMs, 1000)
  assert.equal(repo.setStepDelay(wf.id, 3000).stepDelayMs, 3000)
  // And it survives an edit that is about something else entirely.
  assert.equal(repo.setWorkflowStatus(wf.id, 'disabled').stepDelayMs, 3000)
})

test('the runner settles between steps, and not around the edges of a run', async () => {
  const repo = await import('../src/db/repo.ts')
  const { Runner } = await import('../src/core/runner.ts')

  const step = (id: string) => ({
    id,
    kind: 'click',
    selectors: [{ strategy: 'id', value: '#' + id, score: 92 }],
    timeoutMs: 1000,
  })
  const wf = repo.saveWorkflow({
    name: 'delay-runner',
    description: '',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    stepDelayMs: 2000,
    steps: [step('a'), step('b'), step('c')],
  } as never)

  // A hub that answers every dispatched step immediately, so the only thing
  // between steps is the pause under test.
  const sent: number[] = []
  const waited: number[] = []
  let handler: any = null
  const hub: any = {
    onMessage: (h: any) => { handler = h },
    clientFor: () => ({ profileId: 'p', label: 'x' }),
    send: (_c: unknown, msg: any) => {
      if (msg.t !== 'job.step') return
      sent.push(msg.stepIndex)
      queueMicrotask(() => handler({ t: 'step.ok', jobId: msg.jobId, stepIndex: msg.stepIndex }, {}))
    },
  }
  const runner = new Runner({
    hub,
    onChange: () => {},
    // Recorded rather than taken: a suite that really sits through a second a
    // step stops being a suite anybody runs.
    wait: (ms, then) => { waited.push(ms); then() },
  })

  const job = runner.start(repo.getWorkflow(wf.id)!, {})
  await new Promise((r) => setTimeout(r, 50))

  assert.deepEqual(sent, [0, 1, 2], 'every step ran')
  assert.deepEqual(waited, [2000, 2000], 'twice for three steps — between them, not around them')
  assert.equal(repo.getJob(job.id)!.status, 'done')
})
