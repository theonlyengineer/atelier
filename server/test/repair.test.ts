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
const { stepFromPick } = await import('../src/core/runner.ts')

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

/*
 * Repointing: the repair that changes where a step looks and nothing else.
 *
 * It replaced re-recording one step, which also carried the value across, and
 * that was a mistake worth naming. A page moving says nothing about what a step
 * should type, so a repair that quietly rewrote the value could undo a decision
 * made deliberately weeks earlier. What a step *does* is now unchangeable
 * everywhere: the recorder refuses it, the dashboard refuses it, and this
 * refuses it.
 */

test('a repointed step takes the confirmed name as its best selector', () => {
  const patch = stepFromPick({
    target: 'Generate',
    identifier: { strategy: 'text', value: 'Generate', score: 96 },
    selectors: [
      { strategy: 'xpath', value: '/html/body/b', score: 30 },
      { strategy: 'testid', value: '[data-testid="go"]', score: 98 },
    ],
  })
  assert.equal(patch.selectors![0]!.value, 'Generate')
  assert.equal(patch.selectors!.length, 3)
  assert.equal(patch.target, 'Generate')
})

test('repointing changes nothing but where the step looks and what it is called', () => {
  const patch = stepFromPick({
    target: 'Prompt',
    selectors: [{ strategy: 'id', value: '#f', score: 92 }],
  })
  assert.equal(patch.value, undefined)
  assert.equal(patch.valueMode, undefined)
  assert.equal((patch as Record<string, unknown>).kind, undefined)
})

test('a pick with no identifiable element is refused rather than saved as a dead step', () => {
  assert.throws(() => stepFromPick({ selectors: [] }), /could not be identified/)
})

test('deleting a workflow takes its health record with it', () => {
  const wf = makeWorkflow('health-cascade')
  repo.recordStepMatch(wf.id, 'step-one', 'testid', 98)
  repo.deleteWorkflow(wf.id)
  assert.equal(repo.stepMatches(wf.id).length, 0)
})

/* --------------------------------------------------- one name, one value */

/**
 * The same rule the control panel enforces, on the other write path.
 *
 * A value can be moved between "always this" and "the agent supplies it" long
 * after the recording — from the workflow's page, or by an agent calling
 * set_step_value. Both arrive here, so this is where two fields are stopped
 * from asking for the same thing.
 */

const twoTyped = (name: string) =>
  repo.saveWorkflow({
    name,
    description: 'test',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    steps: [
      {
        id: 'one',
        kind: 'type',
        target: 'Same text',
        selectors: [{ strategy: 'id', value: '#a', score: 92 }],
        valueMode: 'dynamic',
        inputName: 'same_text',
        sampleValue: 'a',
        value: '{{same_text}}',
        timeoutMs: 30000,
      },
      {
        id: 'two',
        kind: 'type',
        target: 'Other',
        selectors: [{ strategy: 'id', value: '#b', score: 92 }],
        valueMode: 'static',
        sampleValue: 'b',
        value: 'b',
        timeoutMs: 30000,
      },
    ],
  } as never)

test('a second field cannot be given a name another already asks for', () => {
  const wf = twoTyped('clash-plain')
  assert.throws(
    () => repo.setStepValue(wf.id, 'two', { valueMode: 'dynamic', inputName: 'same_text' }),
    /already asks the agent for/i,
  )
})

test('and the comparison is on what the name becomes, not on how it was typed', () => {
  // "Same text", "SAME Text" and "same_text" are one name. Comparing the raw
  // strings would let all three through and hand an agent one input where the
  // person thought they had three.
  for (const spelling of ['Same text', 'SAME Text', 'same_text', '  same   TEXT  ']) {
    const wf = twoTyped('clash-' + spelling.replace(/\W+/g, ''))
    assert.throws(
      () => repo.setStepValue(wf.id, 'two', { valueMode: 'dynamic', inputName: spelling }),
      /already asks the agent for/i,
      `"${spelling}" should be refused`,
    )
  }
})

test('a step may keep the name it already has, however it is respelled', () => {
  const wf = twoTyped('keep-own-name')
  const after = repo.setStepValue(wf.id, 'one', { inputName: 'SAME Text', sampleValue: 'changed' })
  assert.equal(after.steps.find((s) => s.id === 'one')!.inputName, 'same_text')
  assert.equal(after.steps.find((s) => s.id === 'one')!.sampleValue, 'changed')
})

test('a free name is fine, and becomes one of the workflow inputs', () => {
  const wf = twoTyped('free-name')
  const after = repo.setStepValue(wf.id, 'two', { valueMode: 'dynamic', inputName: 'Other thing' })
  assert.deepEqual(
    after.inputs.map((i) => i.name),
    ['same_text', 'other_thing'],
  )
})

test('a static value collides with nothing, because nothing asks for it', () => {
  // Setup is replayed exactly and never reaches the caller, so two of them can
  // share a name without anything being ambiguous.
  const wf = twoTyped('static-never-clashes')
  const after = repo.setStepValue(wf.id, 'two', { valueMode: 'static', sampleValue: 'x' })
  assert.deepEqual(
    after.inputs.map((i) => i.name),
    ['same_text'],
  )
})

test('a dynamic value with no usable name at all is refused', () => {
  const wf = twoTyped('blank-name')
  assert.throws(
    () => repo.setStepValue(wf.id, 'two', { valueMode: 'dynamic', inputName: '   ' }),
    /name the agent can pass it under/i,
  )
})
