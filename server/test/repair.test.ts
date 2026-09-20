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

/* --------------------------------------------------- taking a step out */

/**
 * Removing one step from a saved workflow.
 *
 * Deliberately not offered while recording, and the difference is the whole
 * argument: during a recording each step is performed against the page the
 * previous one left behind, so a list you can edit in the middle stops
 * describing anything that was actually done. A saved workflow is not that. It
 * is an artifact being maintained, and the alternative to dropping one stray
 * click from it is re-recording the other nineteen — which is the cost the
 * repair path exists to avoid.
 */

const threeSteps = (name: string) =>
  repo.saveWorkflow({
    name,
    description: 'test',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'image',
    steps: [
      {
        id: 'one',
        kind: 'type',
        target: 'Prompt',
        selectors: [{ strategy: 'id', value: '#p', score: 92 }],
        valueMode: 'dynamic',
        inputName: 'prompt',
        sampleValue: 'a rope bridge',
        value: '{{prompt}}',
        timeoutMs: 30000,
      },
      {
        id: 'stray',
        kind: 'click',
        target: 'Somewhere else',
        selectors: [{ strategy: 'id', value: '#stray', score: 92 }],
        valueMode: 'dynamic',
        inputName: 'stray_value',
        timeoutMs: 30000,
      },
      {
        id: 'three',
        kind: 'capture',
        target: 'The result',
        selectors: [{ strategy: 'id', value: '#out', score: 92 }],
        capture: { as: 'image' },
        timeoutMs: 180000,
      },
    ],
  } as never)

test('a step in the middle comes out, and the rest keep their order', () => {
  const wf = threeSteps('drop-middle')
  const after = repo.removeStep(wf.id, 'stray')
  assert.deepEqual(after.steps.map((s) => s.id), ['one', 'three'])
})

test('what it asked the agent for stops being asked', () => {
  // Inputs are derived from the steps, so a removed dynamic step that kept its
  // name in the signature would leave the agent supplying a value nothing types.
  const wf = threeSteps('drop-input')
  // Derived from the steps the moment anything edits them, so the assertion is
  // about what the workflow ends up declaring rather than what the fixture was
  // handed.
  const after = repo.removeStep(wf.id, 'stray')
  assert.deepEqual(after.inputs.map((i) => i.name), ['prompt'])
  assert.equal(after.steps.some((s) => s.inputName === 'stray_value'), false)
})

test('a wait for the thing just removed goes with it', () => {
  // Left alone it would sit out its whole timeout — three minutes, for a
  // capture — waiting for something nobody is going to take.
  const wf = threeSteps('drop-wait')
  const withWait = repo.replaceStep(wf.id, 'stray', {
    waitAfter: { kind: 'visible', selectors: [{ strategy: 'id', value: '#out', score: 92 }] },
  } as never)
  assert.ok(withWait.steps.find((s) => s.id === 'stray')!.waitAfter)

  const after = repo.removeStep(wf.id, 'three')
  assert.equal(after.steps.find((s) => s.id === 'stray')!.waitAfter, undefined)
})

test('a wait for something else is left exactly where it is', () => {
  const wf = threeSteps('keep-other-wait')
  repo.replaceStep(wf.id, 'stray', {
    waitAfter: { kind: 'visible', selectors: [{ strategy: 'id', value: '#spinner', score: 92 }] },
  } as never)
  const after = repo.removeStep(wf.id, 'three')
  assert.ok(after.steps.find((s) => s.id === 'stray')!.waitAfter, 'not ours to clear')
})

test('what a removed step matched on is forgotten with it', () => {
  const wf = threeSteps('drop-health')
  repo.recordStepMatch(wf.id, 'stray', 'xpath', 30)
  repo.removeStep(wf.id, 'stray')
  assert.equal(repo.stepMatches(wf.id).some((m) => m.stepId === 'stray'), false)
})

test('the last step cannot be removed — that is deleting the workflow', () => {
  const wf = threeSteps('drop-last')
  repo.removeStep(wf.id, 'stray')
  repo.removeStep(wf.id, 'three')
  assert.throws(() => repo.removeStep(wf.id, 'one'), /at least one step/)
  assert.equal(repo.getWorkflow(wf.id)!.steps.length, 1, 'and it is still there')
})

test('a step that is not there is an error, not a silent no-op', () => {
  const wf = threeSteps('drop-missing')
  assert.throws(() => repo.removeStep(wf.id, 'nope'), /no step nope/)
})
