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
    '/api/workflows.run',
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
