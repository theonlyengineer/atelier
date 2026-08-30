/**
 * Turns a raw recording into a proposed workflow.
 *
 * This used to be a language model reading a trace and typing JSON, which meant
 * the decisions below were made slightly differently every time and only when
 * somebody remembered to ask for them. They are not judgement calls — they are
 * the same six rules each time — so they belong in code, where they are
 * deterministic, instant, and testable.
 *
 * The output is always `status: 'draft'`. A recording never becomes something
 * that can run without a human looking at it once.
 */
import { randomUUID } from 'node:crypto'
import type {
  SelectorCandidate,
  Step,
  WaitCondition,
  Workflow,
  WorkflowInput,
} from '../types.ts'

/** The shape the recorder sends. Loose on purpose: it crosses a wire from an
 *  extension that may be a version behind, so unknown fields are ignored rather
 *  than fatal. */
export interface RecordedAction {
  kind: string
  element?: { tag?: string; type?: string | null; label?: string | null; selectors?: SelectorCandidate[] }
  value?: string | null
  secret?: boolean
  capture?: { as?: 'image' | 'text' | 'download'; attribute?: string }
  wait?: { kind?: 'visible' | 'hidden'; ms?: number }
  origin?: string
  url?: string
}

export interface DraftInput {
  name: string
  origins: string[]
  raw: { actions?: RecordedAction[] } | unknown
}

/** A value has to be at least this long before we assume it is the thing you
 *  would want to vary between runs. A quantity or a two-letter code is not. */
const PARAMETER_MIN_LENGTH = 24

/** Generation is slow and a capture that gives up early is the failure this
 *  whole design exists to avoid. Ordinary steps stay snappy. */
const CAPTURE_TIMEOUT_MS = 180_000
const STEP_TIMEOUT_MS = 15_000
const WAIT_TIMEOUT_MS = 180_000

const isUsable = (a: RecordedAction): boolean =>
  a.kind === 'navigate' || a.kind === 'key' || (a.element?.selectors?.length ?? 0) > 0

/** Highest score first. Replay walks the list in this order, so the order *is*
 *  the resilience strategy — and every candidate is kept, because the one that
 *  looks redundant today is the one that still resolves after a redeploy. */
const ranked = (selectors: SelectorCandidate[] = []): SelectorCandidate[] =>
  [...selectors].sort((a, b) => b.score - a.score)

/** Identity of the thing acted on, for collapsing repeated typing into one
 *  step. The best selector is a good enough key: two actions on the same field
 *  produce the same top candidate. */
const targetKey = (a: RecordedAction): string => {
  const best = ranked(a.element?.selectors)[0]
  return best ? `${best.strategy}:${best.value}` : `${a.kind}:${a.element?.label ?? ''}`
}

const humanLabel = (a: RecordedAction): string => {
  const raw = (a.element?.label ?? '').trim()
  if (!raw) return a.element?.tag ?? 'the element'
  return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw
}

/** `Prompt` → `prompt`, `Search query` → `search_query`. Collisions get a
 *  suffix rather than silently overwriting one another. */
function inputName(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'input'
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`
    if (!taken.has(candidate)) return candidate
  }
}

const visible = (selectors: SelectorCandidate[]): WaitCondition => ({ kind: 'visible', selectors })
const hidden = (selectors: SelectorCandidate[]): WaitCondition => ({ kind: 'hidden', selectors })

export function proposeWorkflow(draft: DraftInput): Workflow {
  const raw = (draft.raw ?? {}) as { actions?: RecordedAction[] }
  const actions = Array.isArray(raw.actions) ? raw.actions : []

  if (!Array.isArray(draft.origins) || draft.origins.length === 0) {
    throw new Error(
      'this recording has no origin, so there is nothing to scope it to — re-record it on the page you want it to act on',
    )
  }

  /* --- 1. Drop what cannot run ------------------------------------------ */
  // A click on an element the recorder could not name is a step that will fail
  // every time. Saving it would mean the first run of every workflow parks on a
  // step that was never going to work.
  let usable = actions.filter(isUsable)

  /* --- 2. Keep only the opening navigate -------------------------------- */
  // The recorder emits one on start and one after every in-page navigation.
  // Only the first is a step; the rest are things that happened, not things to
  // do.
  let seenNavigate = false
  usable = usable.filter((a) => {
    if (a.kind !== 'navigate') return true
    if (seenNavigate) return false
    seenNavigate = true
    return true
  })

  /* --- 3. Collapse repeated typing into the same field ------------------ */
  // The recorder debounces keystrokes, but a pause mid-sentence still produces
  // two actions. The last one is the complete value.
  const collapsed: RecordedAction[] = []
  for (const action of usable) {
    const previous = collapsed[collapsed.length - 1]
    if (action.kind === 'type' && previous?.kind === 'type' && targetKey(previous) === targetKey(action)) {
      collapsed[collapsed.length - 1] = action
      continue
    }
    collapsed.push(action)
  }

  if (collapsed.length === 0) {
    throw new Error(
      'nothing was recorded that can be replayed — start a recording, do the task once, then save it',
    )
  }

  /* --- 4. Choose which typed value is the parameter --------------------- */
  // The longest one. A prompt is long; a quantity, a page number and a filter
  // are short. Only the longest is parameterised, because a workflow with four
  // required inputs is one nobody calls.
  const typedActions = collapsed.filter((a) => a.kind === 'type' && !a.secret && (a.value ?? '').length > 0)
  const longest = typedActions.reduce<RecordedAction | null>(
    (best, a) => ((a.value ?? '').length > (best?.value ?? '').length ? a : best),
    null,
  )
  const parameterised =
    longest && (longest.value ?? '').length >= PARAMETER_MIN_LENGTH ? targetKey(longest) : null

  const inputs: WorkflowInput[] = []
  const takenNames = new Set<string>()

  /* --- 5. Build the steps ----------------------------------------------- */
  const steps: Step[] = collapsed.map((action) => {
    const selectors = ranked(action.element?.selectors)
    const label = humanLabel(action)

    // A secret is never written down. It becomes a step that stops and hands
    // the keyboard back — which is also the only correct behaviour, since a
    // replayed stale password is worse than a pause.
    if (action.secret) {
      return {
        id: randomUUID(),
        kind: 'manual',
        selectors,
        timeoutMs: STEP_TIMEOUT_MS,
        note: `Type the password into ${label} yourself — Atelier never records one`,
      }
    }

    if (action.kind === 'wait') {
      const condition = action.wait?.kind === 'hidden' ? hidden(selectors) : visible(selectors)
      return {
        id: randomUUID(),
        kind: 'wait',
        // The condition carries the selector; the step itself acts on nothing,
        // so giving it selectors too would make replay hunt for an element it
        // has no use for.
        selectors: [],
        waitBefore: condition,
        timeoutMs: WAIT_TIMEOUT_MS,
        note:
          action.wait?.kind === 'hidden'
            ? `Wait for ${label} to disappear`
            : `Wait for ${label} to appear`,
      }
    }

    if (action.kind === 'capture') {
      const as = action.capture?.as ?? 'image'
      return {
        id: randomUUID(),
        kind: 'capture',
        selectors,
        capture: { as, ...(action.capture?.attribute ? { attribute: action.capture.attribute } : {}) },
        // The wait the recorder cannot see. Without it a capture fires the
        // instant the step is reached, which on a generator means capturing a
        // spinner and calling the job done.
        waitBefore: visible(selectors),
        timeoutMs: CAPTURE_TIMEOUT_MS,
        note: `Capture the ${as} from ${label}`,
      }
    }

    if (action.kind === 'type') {
      const isParameter = parameterised !== null && targetKey(action) === parameterised
      let value = action.value ?? ''
      if (isParameter) {
        const name = inputName(label, takenNames)
        takenNames.add(name)
        inputs.push({
          name,
          description: `Text typed into ${label}. Composed by the caller and passed whole.`,
          required: true,
        })
        value = `{{${name}}}`
      }
      return {
        id: randomUUID(),
        kind: 'type',
        selectors,
        value,
        timeoutMs: STEP_TIMEOUT_MS,
        note: isParameter ? `Type the ${inputs[inputs.length - 1]!.name} into ${label}` : `Type into ${label}`,
      }
    }

    if (action.kind === 'navigate') {
      return {
        id: randomUUID(),
        kind: 'navigate',
        selectors: [],
        value: action.value ?? '',
        timeoutMs: 30_000,
        note: `Open ${action.value ?? 'the page'}`,
      }
    }

    if (action.kind === 'key') {
      return {
        id: randomUUID(),
        kind: 'key',
        selectors: [],
        value: action.value ?? 'Enter',
        timeoutMs: STEP_TIMEOUT_MS,
        note: `Press ${action.value ?? 'Enter'}`,
      }
    }

    return {
      id: randomUUID(),
      kind: 'click',
      selectors,
      timeoutMs: STEP_TIMEOUT_MS,
      note: `Click ${label}`,
    }
  })

  /* --- 6. Make the step before a capture wait for the result ------------ */
  // This is the single most valuable inference here, and the one a recording
  // physically cannot contain: at the moment you click Generate, the thing you
  // are waiting for does not exist, so there is nothing to point at. Working
  // backwards from what was captured is the only way to recover it.
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i]!
    const previous = steps[i - 1]!
    if (step.kind !== 'capture' || !step.selectors.length) continue
    if (previous.kind !== 'click' || previous.waitAfter) continue
    previous.waitAfter = visible(step.selectors)
    previous.timeoutMs = Math.max(previous.timeoutMs, CAPTURE_TIMEOUT_MS)
    previous.note = `${previous.note}, then wait for the result`
  }

  const captured = steps.find((s) => s.kind === 'capture')
  const producesFromCapture =
    captured?.capture?.as === 'text' ? 'text' : captured?.capture?.as === 'download' ? 'file' : 'image'

  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    name: draft.name,
    description: describe(draft.name, steps, inputs),
    // Never active. A recording that can run the moment it stops is a recording
    // nobody checked.
    status: 'draft',
    origins: [...draft.origins],
    profileId: null,
    inputs,
    steps,
    produces: captured ? producesFromCapture : 'none',
    createdAt: now,
    updatedAt: now,
  }
}

/** A one-line description that says what the thing does, so `list_workflows` is
 *  readable without opening every workflow. */
function describe(name: string, steps: Step[], inputs: WorkflowInput[]): string {
  const captured = steps.find((s) => s.kind === 'capture')
  const verb = captured ? `Produces ${captured.capture?.as ?? 'an image'}` : 'Runs'
  const takes = inputs.length ? ` from ${inputs.map((i) => i.name).join(', ')}` : ''
  return `${verb}${takes} by replaying ${steps.length} recorded step${steps.length === 1 ? '' : 's'} (${name}).`
}
