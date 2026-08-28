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
