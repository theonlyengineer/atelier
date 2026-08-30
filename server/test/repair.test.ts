/**
 * The repair path and the health record, against a real database.
 *
 * propose.test.ts and health.test.ts cover the pure logic. These cover the part
 * that used to be missing entirely: a workflow whose page moved could only be
 * deleted and re-recorded, and nothing anywhere remembered what a step had
 * actually been matching on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ATELIER_HOME = mkdtempSync(join(tmpdir(), 'atelier-repair-'))

const repo = await import('../src/db/repo.ts')
const { assessWorkflow } = await import('../src/core/health.ts')
const { stepFromAction } = await import('../src/core/runner.ts')

const sel = (strategy: string, value: string, score: number) => ({ strategy, value, score }) as never

function makeWorkflow(name: string) {
  return repo.saveWorkflow({
    name,
    description: 'test',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    steps: [
      {
        id: 'step-one',
        kind: 'click',
        selectors: [sel('testid', '[data-testid="go"]', 98), sel('xpath', '/html/body/button', 30)],
        timeoutMs: 15000,
        note: 'Click Generate',
      },
      {
        id: 'step-two',
        kind: 'click',
        selectors: [sel('id', '#next', 92)],
        timeoutMs: 15000,
        note: 'Click Next',
      },
    ],
  } as never)
}

test('a recorded match survives a round trip and reads back as health', () => {
  const wf = makeWorkflow('health-roundtrip')
  repo.recordStepMatch(wf.id, 'step-one', 'xpath', 30)

  const health = assessWorkflow(repo.getWorkflow(wf.id)!, repo.stepMatches(wf.id))
  assert.equal(health.state, 'fragile')
  assert.equal(health.degraded[0]!.stepId, 'step-one')
  assert.match(health.summary, /position/i)
})

test('recording a match twice updates rather than duplicating — the question is "now", not "ever"', () => {
  const wf = makeWorkflow('health-upsert')
  repo.recordStepMatch(wf.id, 'step-one', 'xpath', 30)
  repo.recordStepMatch(wf.id, 'step-one', 'testid', 98)

  const matches = repo.stepMatches(wf.id)
  assert.equal(matches.length, 1)
  assert.equal(matches[0]!.strategy, 'testid')

  // The step itself is healthy again. The *workflow* still reads 'unknown',
  // because step-two has never run — and a workflow that reported itself
  // healthy on the strength of one verified step out of two would be lying.
  const health = assessWorkflow(repo.getWorkflow(wf.id)!, matches)
  assert.equal(health.steps.find((s) => s.stepId === 'step-one')!.state, 'ok')
  assert.equal(health.state, 'unknown')
  assert.equal(health.degraded.length, 0)
})

test('replacing a step keeps its position and its id', () => {
  const wf = makeWorkflow('repair-position')
  const updated = repo.replaceStep(wf.id, 'step-one', {
    selectors: [sel('testid', '[data-testid="generate"]', 98)],
  })
  assert.equal(updated.steps.length, 2)
  assert.equal(updated.steps[0]!.id, 'step-one')
  assert.equal(updated.steps[0]!.selectors[0]!.value, '[data-testid="generate"]')
  assert.equal(updated.steps[1]!.id, 'step-two')
})

test('replacing a step leaves everything it did not name alone', () => {
  // The note, the kind and the timeout were reviewed once. The page moving does
  // not invalidate them, and silently resetting them would be a worse bug than
  // the one being repaired.
  const wf = makeWorkflow('repair-preserve')
  const updated = repo.replaceStep(wf.id, 'step-one', { selectors: [sel('id', '#go2', 92)] })
  assert.equal(updated.steps[0]!.note, 'Click Generate')
  assert.equal(updated.steps[0]!.kind, 'click')
  assert.equal(updated.steps[0]!.timeoutMs, 15000)
})

test('repairing a step forgets its old health, because the old match proves nothing about new selectors', () => {
  const wf = makeWorkflow('repair-clears-health')
  repo.recordStepMatch(wf.id, 'step-one', 'xpath', 30)
  assert.equal(repo.stepMatches(wf.id).length, 1)

  repo.replaceStep(wf.id, 'step-one', { selectors: [sel('testid', '[data-testid="new"]', 98)] })
  assert.equal(repo.stepMatches(wf.id).length, 0)
  assert.equal(assessWorkflow(repo.getWorkflow(wf.id)!, repo.stepMatches(wf.id)).state, 'unknown')
})

test('replacing a step that does not exist is an error, not a silent no-op', () => {
  const wf = makeWorkflow('repair-missing')
  assert.throws(() => repo.replaceStep(wf.id, 'nope', {}), /no step nope/)
})

test('removing a step works, and removing the last one is refused', () => {
  const wf = makeWorkflow('repair-remove')
  const after = repo.removeStep(wf.id, 'step-two')
  assert.deepEqual(after.steps.map((s) => s.id), ['step-one'])
  assert.throws(() => repo.removeStep(wf.id, 'step-one'), /at least one step/)
})

test('a re-recorded action becomes new selectors, best first, and nothing else', () => {
  const patch = stepFromAction({
    element: {
      selectors: [
        { strategy: 'xpath', value: '/html/body/b', score: 30 },
        { strategy: 'testid', value: '[data-testid="go"]', score: 98 },
      ],
    },
  })
  assert.equal(patch.selectors![0]!.strategy, 'testid')
  assert.equal(patch.selectors!.length, 2)
  assert.equal(patch.value, undefined)
  assert.equal((patch as Record<string, unknown>).kind, undefined)
})

test('a re-recorded typed value comes through, but a secret never does', () => {
  const open = stepFromAction({
    element: { selectors: [{ strategy: 'id', value: '#f', score: 92 }] },
    value: 'hello',
  })
  assert.equal(open.value, 'hello')

  const secret = stepFromAction({
    element: { selectors: [{ strategy: 'id', value: '#p', score: 92 }] },
    value: 'hunter2',
    secret: true,
  })
  assert.equal(secret.value, undefined)
})

test('a re-recorded action with no identifiable element is refused rather than saved as a dead step', () => {
  assert.throws(() => stepFromAction({ element: { selectors: [] } }), /could not be identified/)
})

test('deleting a workflow takes its health record with it', () => {
  const wf = makeWorkflow('health-cascade')
  repo.recordStepMatch(wf.id, 'step-one', 'testid', 98)
  repo.deleteWorkflow(wf.id)
  assert.equal(repo.stepMatches(wf.id).length, 0)
})
