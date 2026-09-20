/**
 * What a recording becomes, as a function.
 *
 * These tests are the specification. They used to describe a pass that
 * *inferred* a workflow from a trace of clicks — which value varied, where a
 * wait belonged, which click was incidental — and every one of those inferences
 * has since been deleted, because the person recording now states each of them
 * at the moment the answer is obvious to them and to nobody else.
 *
 * So what is left to test is the assembly, and it is worth testing precisely
 * because it is the part nobody looks at again: the order of the selector list,
 * the timeouts that make replay wait rather than race, the signature derived
 * from the steps, and the two refusals.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ATELIER_HOME = mkdtempSync(join(tmpdir(), 'atelier-propose-'))

const { proposeWorkflow, sampleInputs } = await import('../src/core/propose.ts')

const sel = (candidates: Array<[string, string, number]>) =>
  candidates.map(([strategy, value, score]) => ({ strategy, value, score })) as never

/** A step as the control panel sends it: an element the person pointed at, the
 *  name they confirmed, and the action they chose. */
const step = (over: Record<string, unknown> = {}) => ({
  kind: 'click',
  target: 'Generate',
  identifier: { strategy: 'text', value: 'Generate', score: 96 },
  selectors: sel([['id', '#go', 92]]),
  ...over,
})

const propose = (steps: unknown[], over: Record<string, unknown> = {}) =>
  proposeWorkflow({
    name: 'w',
    origins: ['https://x.test'],
    raw: { startUrl: 'https://x.test/start', steps: steps as never },
    ...over,
  })

/* ------------------------------------------------------------- refusals */

test('an empty recording is rejected rather than promoted to an empty workflow', () => {
  assert.throws(() => propose([]), /nothing was recorded/i)
})

test('a recording with no origin is rejected — an unscoped workflow is the one thing we never save', () => {
  assert.throws(() => propose([step()], { origins: [] }), /origin/i)
})

/* ------------------------------------------------------------ selectors */

test('the name the person confirmed leads the selector list', () => {
  const wf = propose([
    step({
      identifier: { strategy: 'text', value: 'Generate', score: 96 },
      selectors: sel([
        ['css', 'div > button', 40],
        ['testid', '[data-testid="go"]', 98],
      ]),
    }),
  ])
  const generate = wf.steps[1]!
  assert.equal(generate.selectors[0]!.value, 'Generate')
  assert.equal(generate.selectors[0]!.score, 96)
})

test('every harvested candidate is kept below it, because the fallback list is what survives a redeploy', () => {
  const wf = propose([
    step({
      selectors: sel([
        ['css', 'div > button', 40],
        ['testid', '[data-testid="go"]', 98],
        ['xpath', '/html/body/button[1]', 30],
      ]),
    }),
  ])
  const strategies = wf.steps[1]!.selectors.map((s) => s.strategy)
  assert.deepEqual(strategies, ['text', 'testid', 'css', 'xpath'])
})

test('a name that could not be turned into a selector is still the step name', () => {
  const wf = propose([step({ identifier: null, target: 'the third thumbnail' })])
  assert.equal(wf.steps[1]!.target, 'the third thumbnail')
  assert.equal(wf.steps[1]!.selectors[0]!.strategy, 'id')
})

test('a duplicate of the confirmed name is not kept twice', () => {
  const wf = propose([
    step({
      identifier: { strategy: 'text', value: 'Generate', score: 96 },
      selectors: sel([
        ['text', 'Generate', 60],
        ['id', '#go', 92],
      ]),
    }),
  ])
  const texts = wf.steps[1]!.selectors.filter((s) => s.strategy === 'text')
  assert.equal(texts.length, 1)
  assert.equal(texts[0]!.score, 96)
})

/* ---------------------------------------------------------------- shape */

test('the recording opens with where it started, so it does not assume the right tab is already open', () => {
  const wf = propose([step()])
  assert.equal(wf.steps[0]!.kind, 'navigate')
  assert.equal(wf.steps[0]!.value, 'https://x.test/start')
})

test('every step keeps the name it was given, which is what a workflow reads as when it breaks', () => {
  const wf = propose([step({ target: 'Generate image' })])
  assert.equal(wf.steps[1]!.target, 'Generate image')
  assert.equal(wf.steps[1]!.note, 'Click Generate image')
})

test('every step gets a stable id, so one can be repaired or repointed in place', () => {
  const wf = propose([step(), step({ target: 'Download' })])
  const ids = new Set(wf.steps.map((s) => s.id))
  assert.equal(ids.size, wf.steps.length)
  assert.ok(wf.steps.every((s) => typeof s.id === 'string' && s.id.length > 10))
})

test('a proposal is saved as a draft workflow, never active — a human confirms before it can run', () => {
  assert.equal(propose([step()]).status, 'draft')
})

test('origins are carried through exactly as recorded, not widened', () => {
  const wf = proposeWorkflow({
    name: 'w',
    origins: ['https://one.test'],
    raw: { steps: [step()] as never },
  })
  assert.deepEqual(wf.origins, ['https://one.test'])
})

/* --------------------------------------------------------------- values */

test('a dynamic value becomes a {{placeholder}} and a declared input', () => {
  const wf = propose([
    step({
      kind: 'type',
      target: 'Prompt',
      valueMode: 'dynamic',
      sampleValue: 'a rope bridge',
      inputName: 'prompt',
    }),
  ])
  assert.equal(wf.steps[1]!.value, '{{prompt}}')
  assert.deepEqual(
    wf.inputs.map((i) => i.name),
    ['prompt'],
  )
})

test('a dynamic value keeps the text that was actually typed, for a test run', () => {
  const wf = propose([
    step({ kind: 'type', target: 'Prompt', valueMode: 'dynamic', sampleValue: 'a rope bridge' }),
  ])
  assert.equal(wf.steps[1]!.sampleValue, 'a rope bridge')
  assert.deepEqual(sampleInputs(wf), { prompt: 'a rope bridge' })
})

test('a static value is replayed exactly and is not one of the inputs', () => {
  const wf = propose([
    step({ kind: 'type', target: 'System prompt', valueMode: 'static', sampleValue: 'be terse' }),
  ])
  assert.equal(wf.steps[1]!.value, 'be terse')
  assert.deepEqual(wf.inputs, [])
})

test('an input name is derived from what the person called the field', () => {
  const wf = propose([
    step({ kind: 'type', target: 'Search query', valueMode: 'dynamic', sampleValue: 'x' }),
  ])
  assert.deepEqual(
    wf.inputs.map((i) => i.name),
    ['search_query'],
  )
})

test('length decides nothing — a long dynamic value and a short static one both do as they were told', () => {
  const wf = propose([
    step({ kind: 'type', target: 'Style', valueMode: 'static', sampleValue: 'x'.repeat(400) }),
    step({ kind: 'type', target: 'Prompt', valueMode: 'dynamic', sampleValue: 'a cat' }),
  ])
  assert.equal(wf.steps[1]!.value, 'x'.repeat(400))
  assert.equal(wf.steps[2]!.value, '{{prompt}}')
  assert.deepEqual(
    wf.inputs.map((i) => i.name),
    ['prompt'],
  )
})

test('a workflow can take nothing at all', () => {
  const wf = propose([step({ kind: 'type', target: 'Prompt', valueMode: 'static', sampleValue: 'fixed' })])
  assert.deepEqual(wf.inputs, [])
  assert.deepEqual(sampleInputs(wf), {})
})

test('two fields with the same name are one input, not two', () => {
  const wf = propose([
    step({ kind: 'type', target: 'Prompt', valueMode: 'dynamic', sampleValue: 'a' }),
    step({ kind: 'type', target: 'Prompt', valueMode: 'dynamic', sampleValue: 'b' }),
  ])
  assert.equal(wf.inputs.length, 1)
})

/* -------------------------------------------------------------- secrets */

test('a password becomes a step that parks, and its value never reaches the workflow', () => {
  const wf = propose([
    step({ kind: 'manual', target: 'Password', secret: true, sampleValue: 'hunter2' }),
  ])
  const manual = wf.steps[1]!
  assert.equal(manual.kind, 'manual')
  assert.ok(!JSON.stringify(wf).includes('hunter2'))
  assert.match(manual.note!, /never records one/i)
})

/* ------------------------------------------------------ waits and waits */

test('a capture waits for its own target, so it cannot fire on a spinner', () => {
  const wf = propose([step({ kind: 'capture', target: 'Result', capture: { as: 'image' } })])
  const capture = wf.steps[1]!
  assert.equal(capture.waitBefore?.kind, 'visible')
  assert.equal(capture.timeoutMs, 180_000)
})

test('a recorded wait is carried through as a real wait condition', () => {
  const wf = propose([step({ kind: 'wait', target: 'Spinner', wait: { kind: 'hidden' } })])
  const wait = wf.steps[1]!
  assert.equal(wait.waitBefore?.kind, 'hidden')
  // The condition carries the selector; the step itself acts on nothing.
  assert.deepEqual(wait.selectors, [])
  assert.match(wait.note!, /to go/i)
})

test('an ordinary step is patient too, because a page changes a variable moment after the last one', () => {
  const wf = propose([step()])
  assert.equal(wf.steps[1]!.timeoutMs, 30_000)
})

/* ------------------------------------------------------------- produces */

test('produces is taken from what was captured', () => {
  assert.equal(propose([step({ kind: 'capture', capture: { as: 'image' } })]).produces, 'image')
  assert.equal(propose([step({ kind: 'capture', capture: { as: 'text' } })]).produces, 'text')
  assert.equal(propose([step({ kind: 'capture', capture: { as: 'download' } })]).produces, 'file')
  assert.equal(propose([step()]).produces, 'none')
})

test('an unknown action from a newer extension is treated as a click rather than fatal', () => {
  const wf = propose([step({ kind: 'teleport' })])
  assert.equal(wf.steps[1]!.kind, 'click')
})
