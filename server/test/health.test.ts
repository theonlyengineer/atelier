/**
 * Selector health.
 *
 * Replay already tries candidates best-first and takes whichever resolves. What
 * it never did was say *which one* — so a workflow quietly sliding from a
 * data-testid down to a positional XPath looked exactly like a healthy one,
 * right up to the morning it stopped working. These tests pin the difference.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ATELIER_HOME = mkdtempSync(join(tmpdir(), 'atelier-health-'))

const { assessWorkflow } = await import('../src/core/health.ts')

const step = (id: string, candidates: Array<[string, number]>, note = 'Click Send') => ({
  id,
  kind: 'click' as const,
  note,
  selectors: candidates.map(([strategy, score]) => ({ strategy, value: `sel-${strategy}`, score })),
  timeoutMs: 15000,
})

const workflow = (steps: unknown[]) => ({ name: 'w', steps }) as never

test('a step that has never run is unknown, not healthy', () => {
  const h = assessWorkflow(workflow([step('a', [['testid', 98]])]), [])
  assert.equal(h.steps[0]!.state, 'unknown')
  assert.equal(h.state, 'unknown')
})

test('matching on the selector it was recorded with is healthy', () => {
  const h = assessWorkflow(workflow([step('a', [['testid', 98], ['xpath', 30]])]), [
    { stepId: 'a', strategy: 'testid', score: 98, at: '2026-08-30T00:00:00Z' },
  ])
  assert.equal(h.steps[0]!.state, 'ok')
  assert.equal(h.state, 'ok')
})

test('falling back to a weaker selector is degraded, and says which one it fell to', () => {
  const h = assessWorkflow(workflow([step('a', [['testid', 98], ['aria', 88]])]), [
    { stepId: 'a', strategy: 'aria', score: 88, at: '2026-08-30T00:00:00Z' },
  ])
  assert.equal(h.steps[0]!.state, 'degraded')
  assert.match(h.steps[0]!.detail, /testid/)
  assert.match(h.steps[0]!.detail, /aria/)
})

test('falling all the way to a positional selector is fragile — this is the one that breaks next', () => {
  const h = assessWorkflow(workflow([step('a', [['testid', 98], ['xpath', 30]])]), [
    { stepId: 'a', strategy: 'xpath', score: 30, at: '2026-08-30T00:00:00Z' },
  ])
  assert.equal(h.steps[0]!.state, 'fragile')
  assert.equal(h.state, 'fragile')
})

test('a workflow is only as healthy as its worst step', () => {
  const h = assessWorkflow(
    workflow([step('a', [['testid', 98]]), step('b', [['testid', 98], ['xpath', 30]])]),
    [
      { stepId: 'a', strategy: 'testid', score: 98, at: '2026-08-30T00:00:00Z' },
      { stepId: 'b', strategy: 'xpath', score: 30, at: '2026-08-30T00:00:00Z' },
    ],
  )
  assert.equal(h.state, 'fragile')
  assert.equal(h.degraded.length, 1)
  assert.equal(h.degraded[0]!.stepId, 'b')
})

test('steps that do not look anything up are not assessed', () => {
  // A navigate or a key press has no selectors, so it has no health to report
  // and should not dilute the count.
  const h = assessWorkflow(
    workflow([
      { id: 'n', kind: 'navigate', selectors: [], value: 'https://x.test', timeoutMs: 30000 },
      step('a', [['testid', 98]]),
    ]),
    [{ stepId: 'a', strategy: 'testid', score: 98, at: '2026-08-30T00:00:00Z' }],
  )
  assert.equal(h.steps.length, 1)
  assert.equal(h.steps[0]!.stepId, 'a')
})

test('the summary names the count and is safe to put in front of a human', () => {
  const h = assessWorkflow(
    workflow([step('a', [['testid', 98], ['xpath', 30]], 'Click Generate')]),
    [{ stepId: 'a', strategy: 'xpath', score: 30, at: '2026-08-30T00:00:00Z' }],
  )
  assert.match(h.summary, /1 of 1/)
  assert.match(h.summary, /position/i)
})

test('a fully healthy workflow says so plainly rather than staying silent', () => {
  const h = assessWorkflow(workflow([step('a', [['testid', 98]])]), [
    { stepId: 'a', strategy: 'testid', score: 98, at: '2026-08-30T00:00:00Z' },
  ])
  assert.match(h.summary, /all 1/i)
  assert.equal(h.degraded.length, 0)
})

test('a match on a selector the workflow no longer has is treated as degraded, not ignored', () => {
  // The step was edited and the old candidate removed, but the recorded match
  // predates the edit. Reporting "ok" there would be a lie.
  const h = assessWorkflow(workflow([step('a', [['testid', 98]])]), [
    { stepId: 'a', strategy: 'css', score: 40, at: '2026-08-30T00:00:00Z' },
  ])
  assert.notEqual(h.steps[0]!.state, 'ok')
})
