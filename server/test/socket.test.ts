/**
 * Integration test over the real WebSocket, standing in for the extension.
 *
 * This is the path that broke: the panel reported "not connected" about a live
 * socket, and nothing in the unit tests could have caught it because the bug was
 * in the handshake between three processes.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

process.env.ATELIER_HOME = mkdtempSync(join(tmpdir(), 'atelier-sock-'))
const PORT = 7799

const { startDaemon } = await import('../src/daemon.ts')
const repo = await import('../src/db/repo.ts')

let stop: () => void

before(async () => {
  const d = await startDaemon(PORT)
  stop = d.close
})
after(() => stop?.())

/** Connect, say hello, and collect frames until `predicate` is satisfied. */
function session(onOpen: (ws: WebSocket) => void, predicate: (m: any) => boolean, timeoutMs = 4000) {
  return new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('timed out waiting for the expected frame'))
    }, timeoutMs)
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', profileId: 'test-profile', label: 'test', browser: 'chrome' }))
      onOpen(ws)
    })
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      if (predicate(msg)) {
        clearTimeout(timer)
        ws.close()
        resolve(msg)
      }
    })
    ws.on('error', reject)
  })
}

test('a hello is acknowledged', async () => {
  const ack = await session(() => {}, (m) => m.t === 'hello.ok')
  assert.equal(ack.serverVersion, '0.1.0')
})

test('the daemon pushes state unprompted after hello', async () => {
  // This is what the side panel depends on to know it is live.
  const state = await session(() => {}, (m) => m.t === 'state')
  assert.ok(Array.isArray(state.jobs))
  assert.ok(Array.isArray(state.workflows))
})

test('state.request pushes a fresh frame on demand', async () => {
  // The panel opens at an arbitrary moment; without this it renders whatever
  // the service worker last cached, which on an idle system is nothing.
  let seen = 0
  const state = await session(
    (ws) => setTimeout(() => ws.send(JSON.stringify({ t: 'state.request' })), 150),
    (m) => m.t === 'state' && ++seen === 2,
  )
  assert.equal(state.t, 'state')
})

test('a draft.save creates a reviewable draft', async () => {
  // This is the whole output of a recording session; if the daemon does not
  // accept it, the user's clicking is lost with nothing to show for it.
  await session(
    (ws) =>
      setTimeout(
        () =>
          ws.send(
            JSON.stringify({
              t: 'draft.save',
              name: 'recorded-thing',
              origins: ['https://example.test'],
              raw: { actions: [{ kind: 'click', element: { tag: 'button' } }] },
            }),
          ),
        150,
      ),
    (m) => m.t === 'state' && repo.listDrafts(true).some((d) => d.name === 'recorded-thing'),
  )

  const draft = repo.listDrafts(true).find((d) => d.name === 'recorded-thing')
  assert.ok(draft, 'the draft should be listed as awaiting review')
  const full = repo.getDraft(draft!.id)!
  assert.equal(full.reviewed, false)
  assert.deepEqual(full.origins, ['https://example.test'])
  assert.equal((full.raw as any).actions.length, 1)
})

test('a connected browser unblocks a job that was waiting for one', async () => {
  const w = repo.saveWorkflow({
    name: 'sock-wf',
    description: '',
    status: 'active',
    origins: ['https://example.test'],
    profileId: null,
    inputs: [],
    steps: [{ id: 's1', kind: 'click', selectors: [], timeoutMs: 1000 }],
    produces: 'none',
  })
  const job = repo.createJob(w.id, {}, 1)
  repo.updateJob(job.id, { status: 'blocked', blockedReason: 'Waiting for a browser — open Chrome.' })

  // Connecting should pick the parked job back up and dispatch its first step.
  const step = await session(() => {}, (m) => m.t === 'job.step' && m.workflowName === 'sock-wf')
  assert.equal(step.stepIndex, 0)
  assert.deepEqual(step.origins, ['https://example.test'])
})

/* ------------------------------------------------ recording → workflow */

test('a saved recording becomes a workflow without anyone asking', async () => {
  // Saving a recording used to leave a draft in the popup under the words "ask
  // Claude Code to review drafts" — the product handing the user an errand in
  // another application.
  const proposed = await session(
    (ws) => {
      ws.send(
        JSON.stringify({
          t: 'draft.save',
          name: 'auto-proposed',
          origins: ['https://example.test'],
          raw: {
            startUrl: 'https://example.test/app',
            steps: [
              {
                kind: 'type',
                target: 'Prompt',
                identifier: { strategy: 'placeholder', value: '[placeholder="Prompt"]', score: 96 },
                selectors: [{ strategy: 'id', value: '#prompt', score: 92 }],
                valueMode: 'dynamic',
                sampleValue: 'a rope bridge with its middle planks missing',
                inputName: 'prompt',
              },
              {
                kind: 'click',
                target: 'Generate',
                identifier: { strategy: 'text', value: 'Generate', score: 96 },
                selectors: [{ strategy: 'testid', value: '[data-testid="go"]', score: 98 }],
              },
              {
                kind: 'capture',
                target: 'The result',
                selectors: [{ strategy: 'css', value: 'main img', score: 40 }],
                capture: { as: 'image', attribute: 'src' },
              },
            ],
          },
        }),
      )
    },
    (m) => m.t === 'workflow.proposed',
  )

  assert.equal(proposed.name, 'auto-proposed')
  assert.deepEqual(proposed.inputs, ['prompt'])
  assert.equal(proposed.produces, 'image')

  const saved = repo.getWorkflowByName('auto-proposed')!
  assert.ok(saved, 'the proposal should be persisted')
  // Proposed, never live. Nothing runs until a human says so.
  assert.equal(saved.status, 'draft')
  // The name the person confirmed leads the selector list, so the workflow
  // reads as a sentence when somebody comes to it cold.
  const trigger = saved.steps.find((s) => s.target === 'Generate')!
  assert.equal(trigger.selectors[0]!.value, 'Generate')
  // And the wait nobody was there to do: at record time the person waited for
  // the image before pointing at it, so the capture has to wait on replay.
  const capture = saved.steps.find((s) => s.kind === 'capture')!
  assert.equal(capture.waitBefore!.kind, 'visible')
  assert.equal(capture.timeoutMs, 180_000)
})

test('a recording that cannot be replayed does not silently become a workflow', async () => {
  await session(
    (ws) => {
      ws.send(
        JSON.stringify({
          t: 'draft.save',
          name: 'unusable-recording',
          origins: ['https://example.test'],
          raw: { startUrl: 'https://example.test/app', steps: [] },
        }),
      )
    },
    (m) => m.t === 'state',
  )
  assert.equal(repo.getWorkflowByName('unusable-recording'), null)
  // The recording itself survives, so nothing the human did is lost.
  assert.ok(repo.listDrafts(false).some((d: any) => d.name === 'unusable-recording'))
})

test('a step ack carrying what it matched on is recorded as health', async () => {
  const workflow = repo.saveWorkflow({
    name: 'health-over-the-wire',
    description: 'test',
    status: 'active',
    origins: ['https://example.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    steps: [
      {
        id: 'only-step',
        kind: 'click',
        selectors: [
          { strategy: 'testid', value: '[data-testid="go"]', score: 98 },
          { strategy: 'xpath', value: '/html/body/button', score: 30 },
        ],
        timeoutMs: 15000,
        note: 'Click Generate',
      },
    ],
  } as never)

  // Driven directly rather than through session(): this test has to ack the
  // exact step the daemon dispatches to it, which means holding the socket open
  // across a request rather than resolving on the first frame that matches a
  // shape.
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('the daemon never dispatched the step'))
    }, 6000)

    ws.on('open', () => {
      ws.send(
        JSON.stringify({ t: 'hello', profileId: 'health-profile', label: 'health', browser: 'chrome' }),
      )
      fetch(`http://127.0.0.1:${PORT}/api/workflows.run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'health-over-the-wire', inputs: {} }),
      }).catch(reject)
    })

    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.t !== 'job.step') return
      // Report that only the last-resort selector resolved — the exact
      // situation that used to be invisible.
      ws.send(
        JSON.stringify({
          t: 'step.ok',
          jobId: msg.jobId,
          stepIndex: msg.stepIndex,
          matched: { strategy: 'xpath', score: 30 },
        }),
      )
      clearTimeout(timer)
      setTimeout(() => {
        ws.close()
        resolve()
      }, 150)
    })

    ws.on('error', reject)
  })

  const matches = repo.stepMatches(workflow.id)
  assert.equal(matches.length, 1)
  assert.equal(matches[0]!.strategy, 'xpath')

  // And the point of recording it: the workflow now says it is decaying.
  const { assessWorkflow } = await import('../src/core/health.ts')
  const health = assessWorkflow(repo.getWorkflow(workflow.id)!, matches)
  assert.equal(health.state, 'fragile')
  assert.match(health.summary, /position/i)
})

test('activating a proposal is what makes it runnable, and only that', async () => {
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await res.json()) as any
  }

  repo.saveWorkflow({
    name: 'awaiting-yes',
    description: 'test',
    status: 'draft',
    origins: ['https://example.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    steps: [{ id: 's1', kind: 'click', selectors: [{ strategy: 'id', value: '#a', score: 92 }], timeoutMs: 15000 }],
  } as never)

  const refused = await call('/api/workflows.run', { name: 'awaiting-yes', inputs: {} })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /only active workflows can run/)

  const activated = await call('/api/workflows.activate', { name: 'awaiting-yes' })
  assert.equal(activated.result.workflow.status, 'active')
})
