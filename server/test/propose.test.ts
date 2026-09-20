/**
 * The review pass, as a function.
 *
 * These tests are the specification for what a recording becomes. Every one of
 * them is a decision that used to be made by a language model reading a trace
 * and typing JSON, which meant it was made differently each time and only when
 * somebody remembered to ask.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ATELIER_HOME = mkdtempSync(join(tmpdir(), 'atelier-propose-'))

const { proposeWorkflow } = await import('../src/core/propose.ts')

/** A recorded element, with the candidate list the recorder actually produces. */
const el = (label: string, candidates: Array<[string, string, number]>) => ({
  tag: 'button',
  type: null,
  label,
  selectors: candidates.map(([strategy, value, score]) => ({ strategy, value, score })),
})

const typed = (label: string, value: string, extra: Record<string, unknown> = {}) => ({
  kind: 'type',
  element: { ...el(label, [['id', '#prompt', 92]]), tag: 'textarea' },
  value,
  ...extra,
})

test('an empty recording is rejected rather than promoted to an empty workflow', () => {
  assert.throws(
    () => proposeWorkflow({ name: 'empty', origins: ['https://x.test'], raw: { actions: [] } }),
    /nothing was recorded/i,
  )
})

test('a recording with no origin is rejected — an unscoped workflow is the one thing we never save', () => {
  assert.throws(
    () =>
      proposeWorkflow({
        name: 'no-origin',
        origins: [],
        raw: { actions: [{ kind: 'click', element: el('Go', [['id', '#go', 92]]) }] },
      }),
    /origin/i,
  )
})

test('selectors are ordered best-first so replay tries the most durable one', () => {
  const wf = proposeWorkflow({
    name: 'ordering',
    origins: ['https://x.test'],
    raw: {
      actions: [
        {
          kind: 'click',
          element: el('Send', [
            ['xpath', '/html/body/div[1]/button', 30],
            ['testid', '[data-testid="send"]', 98],
            ['css', 'div > button', 40],
          ]),
        },
      ],
    },
  })
  assert.deepEqual(
    wf.steps[0]!.selectors.map((s) => s.strategy),
    ['testid', 'css', 'xpath'],
  )
})

test('every candidate is kept, because the fallback list is what survives a redeploy', () => {
  const wf = proposeWorkflow({
    name: 'keep-all',
    origins: ['https://x.test'],
    raw: {
      actions: [
        {
          kind: 'click',
          element: el('Send', [
            ['testid', '[data-testid="send"]', 98],
            ['aria', '[aria-label="Send"]', 88],
            ['xpath', '/html/body/button', 30],
          ]),
        },
      ],
    },
  })
  assert.equal(wf.steps[0]!.selectors.length, 3)
})

test('a typed value becomes a {{placeholder}} and a declared input', () => {
  // Typing something by hand during a recording is the signal that it is a
  // value somebody supplies. Nothing is guessed from how long it is.
  const wf = proposeWorkflow({
    name: 'params',
    origins: ['https://x.test'],
    raw: {
      actions: [
        typed('Prompt', 'a watercolour of a harbour at dusk'),
        { kind: 'click', element: el('Send', [['testid', '[data-testid="send"]', 98]]) },
      ],
    },
  })
  const typeStep = wf.steps.find((s) => s.kind === 'type')
  assert.equal(typeStep!.value, '{{prompt}}')
  assert.deepEqual(
    wf.inputs.map((i) => i.name),
    ['prompt'],
  )
  assert.equal(wf.inputs[0]!.required, true)
})

test('a short typed value is an input too — length was never the question', () => {
  const wf = proposeWorkflow({
    name: 'short',
    origins: ['https://x.test'],
    raw: { actions: [typed('Qty', '2'), { kind: 'click', element: el('Go', [['id', '#go', 92]]) }] },
  })
  assert.equal(wf.steps[0]!.value, '{{qty}}')
  assert.deepEqual(wf.inputs.map((i) => i.name), ['qty'])
})

test('a password becomes a manual step that parks, and its value never reaches the workflow', () => {
  const wf = proposeWorkflow({
    name: 'secret',
    origins: ['https://x.test'],
    raw: {
      actions: [
        { kind: 'type', element: el('Password', [['name', '[name="pw"]', 80]]), value: null, secret: true },
        { kind: 'click', element: el('Sign in', [['id', '#in', 92]]) },
      ],
    },
  })
  assert.equal(wf.steps[0]!.kind, 'manual')
  assert.equal(wf.steps[0]!.value, undefined)
  assert.match(JSON.stringify(wf), /^(?!.*"pw-value").*$/)
  assert.match(wf.steps[0]!.note ?? '', /yourself/i)
})

test('a capture step gets a wait for its own target, so it cannot fire on a spinner', () => {
  const wf = proposeWorkflow({
    name: 'capture-wait',
    origins: ['https://x.test'],
    raw: {
      actions: [
        { kind: 'click', element: el('Generate', [['testid', '[data-testid="go"]', 98]]) },
        {
          kind: 'capture',
          element: el('result', [['css', 'main img', 40]]),
          capture: { as: 'image', attribute: 'src' },
        },
      ],
    },
  })
  const cap = wf.steps.find((s) => s.kind === 'capture')!
  assert.ok(cap.waitBefore, 'capture must wait for its target to exist')
  assert.equal(cap.waitBefore!.kind, 'visible')
  assert.ok(cap.timeoutMs >= 120000, 'a generation wait needs a generous timeout')
})

test('the step before a capture waits too — that is the "click generate and wait" the recorder cannot see', () => {
  const wf = proposeWorkflow({
    name: 'trigger-wait',
    origins: ['https://x.test'],
    raw: {
      actions: [
        { kind: 'click', element: el('Generate', [['testid', '[data-testid="go"]', 98]]) },
        {
          kind: 'capture',
          element: el('result', [['css', 'main img', 40]]),
          capture: { as: 'image' },
        },
      ],
    },
  })
  const trigger = wf.steps[0]!
  assert.equal(trigger.kind, 'click')
  assert.ok(trigger.waitAfter, 'the trigger should wait for the result to appear')
  assert.equal(trigger.waitAfter!.kind, 'visible')
})

test('a recorded wait gesture is carried through as a real wait condition', () => {
  const wf = proposeWorkflow({
    name: 'explicit-wait',
    origins: ['https://x.test'],
    raw: {
      actions: [
        { kind: 'click', element: el('Go', [['id', '#go', 92]]) },
        { kind: 'wait', element: el('spinner', [['css', '.spinner', 40]]), wait: { kind: 'hidden' } },
        { kind: 'click', element: el('Next', [['id', '#next', 92]]) },
      ],
    },
  })
  const wait = wf.steps.find((s) => s.kind === 'wait')!
  assert.equal(wait.waitBefore!.kind, 'hidden')
  assert.equal(wait.selectors.length, 0, 'a wait step acts on nothing; the condition carries the selector')
})

test('produces is inferred from what was captured', () => {
  const image = proposeWorkflow({
    name: 'p-image',
    origins: ['https://x.test'],
    raw: {
      actions: [{ kind: 'capture', element: el('r', [['css', 'img', 40]]), capture: { as: 'image' } }],
    },
  })
  assert.equal(image.produces, 'image')

  const textual = proposeWorkflow({
    name: 'p-text',
    origins: ['https://x.test'],
    raw: {
      actions: [{ kind: 'capture', element: el('r', [['css', 'pre', 40]]), capture: { as: 'text' } }],
    },
  })
  assert.equal(textual.produces, 'text')

  const nothing = proposeWorkflow({
    name: 'p-none',
    origins: ['https://x.test'],
    raw: { actions: [{ kind: 'click', element: el('Go', [['id', '#go', 92]]) }] },
  })
  assert.equal(nothing.produces, 'none')
})

test('the leading navigate is kept and later same-page navigates are dropped', () => {
  const wf = proposeWorkflow({
    name: 'nav',
    origins: ['https://x.test'],
    raw: {
      actions: [
        { kind: 'navigate', value: 'https://x.test/app', origin: 'https://x.test' },
        { kind: 'click', element: el('Go', [['id', '#go', 92]]) },
        { kind: 'navigate', value: 'https://x.test/app', origin: 'https://x.test' },
      ],
    },
  })
  assert.equal(wf.steps.filter((s) => s.kind === 'navigate').length, 1)
  assert.equal(wf.steps[0]!.kind, 'navigate')
})

test('an element clicked with no usable selector is dropped rather than saved as a step that cannot run', () => {
  const wf = proposeWorkflow({
    name: 'unusable',
    origins: ['https://x.test'],
    raw: {
      actions: [
        { kind: 'click', element: { tag: 'div', label: null, selectors: [] } },
        { kind: 'click', element: el('Go', [['id', '#go', 92]]) },
      ],
    },
  })
  assert.equal(wf.steps.length, 1)
  assert.equal(wf.steps[0]!.note, 'Click Go')
})

test('steps carry readable notes, because a workflow is read by a human when it breaks', () => {
  const wf = proposeWorkflow({
    name: 'notes',
    origins: ['https://x.test'],
    raw: {
      actions: [
        typed('Prompt', 'a long piece of text that is obviously the thing you would want to vary'),
        { kind: 'click', element: el('Send', [['testid', '[data-testid="send"]', 98]]) },
      ],
    },
  })
  assert.equal(wf.steps[0]!.note, 'Type the prompt into Prompt')
  assert.equal(wf.steps[1]!.note, 'Click Send')
})

test('a proposal is saved as a draft workflow, never active — a human confirms before it can run', () => {
  const wf = proposeWorkflow({
    name: 'not-live',
    origins: ['https://x.test'],
    raw: { actions: [{ kind: 'click', element: el('Go', [['id', '#go', 92]]) }] },
  })
  assert.equal(wf.status, 'draft')
})

test('every step gets a stable id, so one can be edited or re-recorded in place', () => {
  const wf = proposeWorkflow({
    name: 'ids',
    origins: ['https://x.test'],
    raw: {
      actions: [
        { kind: 'click', element: el('A', [['id', '#a', 92]]) },
        { kind: 'click', element: el('B', [['id', '#b', 92]]) },
      ],
    },
  })
  const ids = wf.steps.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.every(Boolean))
})

test('consecutive typing into the same field collapses to the last value', () => {
  const target = el('Prompt', [['id', '#prompt', 92]])
  const wf = proposeWorkflow({
    name: 'debounce',
    origins: ['https://x.test'],
    raw: {
      actions: [
        { kind: 'type', element: target, value: 'half of the sentence' },
        { kind: 'type', element: target, value: 'half of the sentence and the rest of it too' },
        { kind: 'click', element: el('Send', [['id', '#send', 92]]) },
      ],
    },
  })
  const types = wf.steps.filter((s) => s.kind === 'type')
  assert.equal(types.length, 1)
  assert.equal(types[0]!.value, '{{prompt}}')
  assert.equal(wf.inputs[0]!.name, 'prompt')
})

test('origins are carried through exactly as recorded, not widened', () => {
  const wf = proposeWorkflow({
    name: 'origins',
    origins: ['https://a.test', 'https://b.test'],
    raw: { actions: [{ kind: 'click', element: el('Go', [['id', '#go', 92]]) }] },
  })
  assert.deepEqual(wf.origins, ['https://a.test', 'https://b.test'])
})

/* ------------------------------------------- kept values vs supplied ones */

/** Typed into a named field of its own, so each one has a distinct target key.
 *  The shared `typed` helper above deliberately reuses one selector, which is
 *  what makes it useful for the collapsing test and useless for this group. */
const into = (label: string, id: string, value: string, extra: Record<string, unknown> = {}) => ({
  kind: 'type',
  element: { tag: 'textarea', type: null, label, selectors: [{ strategy: 'id', value: id, score: 92 }] },
  value,
  ...extra,
})

const LONG_CONSTANT =
  'You are a careful assistant. Answer in plain language, never invent a citation, and keep every reply under two paragraphs.'

test('every typed field is an input, however many there are', () => {
  const wf = proposeWorkflow({
    name: 'several',
    origins: ['https://x.test'],
    raw: {
      actions: [
        into('Prompt', '#prompt', 'a harbour at dusk'),
        into('Aspect ratio', '#ratio', '16:9'),
        { kind: 'click', element: el('Run', [['id', '#run', 92]]) },
      ],
    },
  })
  assert.deepEqual(wf.inputs.map((i) => i.name), ['prompt', 'aspect_ratio'])
  assert.equal(wf.steps.find((s) => s.note?.includes('Prompt'))!.value, '{{prompt}}')
  assert.equal(wf.steps.find((s) => s.note?.includes('Aspect'))!.value, '{{aspect_ratio}}')
})

test('a field kept as a static value is replayed exactly, and asks for nothing', () => {
  // The one thing the person has to say: this text is setup, not a value. It is
  // said by ticking the field in the panel, and the text they typed is what is
  // kept.
  const wf = proposeWorkflow({
    name: 'kept',
    origins: ['https://x.test'],
    raw: {
      actions: [
        into('Instructions', '#sys', LONG_CONSTANT, { role: 'fixed' }),
        into('Prompt', '#prompt', 'a harbour at dusk'),
        { kind: 'click', element: el('Run', [['id', '#run', 92]]) },
      ],
    },
  })
  assert.equal(wf.steps.find((s) => s.note?.includes('Instructions'))!.value, LONG_CONSTANT)
  assert.deepEqual(wf.inputs.map((i) => i.name), ['prompt'])
})

test('length decides nothing — the long field is the input if it was not kept', () => {
  // The old rule made the longest typed value the parameter, which inverted
  // exactly this case: a long constant typed once as setup became the thing the
  // caller had to supply, and the short thing that actually varies was frozen.
  const wf = proposeWorkflow({
    name: 'not-length',
    origins: ['https://x.test'],
    raw: {
      actions: [
        into('Instructions', '#sys', LONG_CONSTANT),
        into('Seed', '#seed', '4471', { role: 'fixed' }),
        { kind: 'click', element: el('Run', [['id', '#run', 92]]) },
      ],
    },
  })
  assert.deepEqual(wf.inputs.map((i) => i.name), ['instructions'])
  assert.equal(wf.steps.find((s) => s.note?.includes('Seed'))!.value, '4471')
})

test('a workflow can keep every value and take nothing at all', () => {
  const wf = proposeWorkflow({
    name: 'all-kept',
    origins: ['https://x.test'],
    raw: {
      actions: [
        into('Instructions', '#sys', LONG_CONSTANT, { role: 'fixed' }),
        { kind: 'click', element: el('Run', [['id', '#run', 92]]) },
      ],
    },
  })
  assert.equal(wf.inputs.length, 0, 'a workflow that takes nothing is a valid workflow')
  assert.equal(wf.steps[0]!.value, LONG_CONSTANT)
})

test('keeping a value survives going back to correct a typo in it', () => {
  const wf = proposeWorkflow({
    name: 'collapse-role',
    origins: ['https://x.test'],
    raw: {
      actions: [
        into('Instructions', '#sys', 'You are a careful', { role: 'fixed' }),
        into('Instructions', '#sys', LONG_CONSTANT),
        { kind: 'click', element: el('Run', [['id', '#run', 92]]) },
      ],
    },
  })
  assert.equal(wf.inputs.length, 0, 'the mark is on the field, not on one keystroke burst')
  assert.equal(wf.steps[0]!.value, LONG_CONSTANT, 'and the last value typed is the one kept')
})

test('a password is never an input — its value was never recorded', () => {
  const wf = proposeWorkflow({
    name: 'secret-not-input',
    origins: ['https://x.test'],
    raw: {
      actions: [
        into('Password', '#pw', 'hunter2', { secret: true }),
        into('Prompt', '#prompt', 'a harbour at dusk'),
        { kind: 'click', element: el('Run', [['id', '#run', 92]]) },
      ],
    },
  })
  assert.deepEqual(wf.inputs.map((i) => i.name), ['prompt'])
})
