/**
 * Turns a recording into a workflow.
 *
 * What this file has to do changed completely when recording did. It used to
 * watch a person work and *infer* a workflow from the trace — which value
 * varied, which click was incidental, where the page needed a wait. Every one
 * of those was a guess about intent made from evidence that does not contain
 * intent, and the guesses were wrong in the ordinary case often enough to be
 * the tool's worst property.
 *
 * Now the person states each step: they point at an element, confirm what to
 * call it, choose the action, and say whether the value is theirs or the
 * caller's. So nothing here infers anything. It assembles: ranks the selectors,
 * puts the confirmed name at the top of that list, derives the workflow's
 * inputs from the steps marked dynamic, and sets the timeouts that make replay
 * wait rather than race.
 *
 * It stays in code, pure and tested, for the reason it always did: these are
 * the same rules every time, so they should not be re-decided in a conversation.
 *
 * The output is always `status: 'draft'`. A recording never becomes something
 * that can run without a human looking at it once.
 */
import { randomUUID } from 'node:crypto'
import { inputsFrom, inputNameFor } from './inputs.ts'
import type {
  CaptureFrom,
  SelectorCandidate,
  Step,
  StepKind,
  ValueMode,
  WaitCondition,
  Workflow,
} from '../types.ts'

/**
 * One step as the recorder sends it.
 *
 * Loose on purpose: it crosses a wire from an extension that may be a version
 * behind, so unknown fields are ignored rather than fatal.
 */
export interface RecordedStep {
  kind?: string
  /** What the person confirmed this element is called. */
  target?: string
  /** The selector built from that confirmed name, if one could be. */
  identifier?: SelectorCandidate | null
  /** Everything else the recorder could find its way back to the element by. */
  selectors?: SelectorCandidate[]
  value?: string | null
  valueMode?: ValueMode
  /** What was actually typed, kept whether the value is static or dynamic. */
  sampleValue?: string | null
  inputName?: string | null
  capture?: { as?: 'image' | 'text' | 'download'; attribute?: string; from?: CaptureFrom }
  wait?: { kind?: 'visible' | 'hidden' }
  secret?: boolean
  note?: string
}

export interface DraftInput {
  name: string
  projectId?: string
  /** What the person said it is for. Empty when they were not asked, or when an
   *  older extension saved the recording. */
  description?: string
  origins: string[]
  raw: { startUrl?: string; steps?: RecordedStep[] } | unknown
}

/**
 * Timeouts, and why they are this size.
 *
 * Replay resolves a selector by trying every candidate and, if none of them
 * hits, trying again a fraction of a second later until the timeout. That poll
 * *is* the answer to "the page changes a variable amount of time after the
 * previous step" — there is nothing to configure and no observer to leak,
 * because a step that cannot find its element yet is indistinguishable from one
 * whose element is about to appear, and waiting handles both.
 *
 * So the number is a patience budget. Ordinary steps get long enough for a
 * render or a route change; a capture gets long enough for something to be
 * generated, which is the slow thing this tool exists for.
 */
const CAPTURE_TIMEOUT_MS = 180_000
const WAIT_TIMEOUT_MS = 180_000
const STEP_TIMEOUT_MS = 30_000
const NAVIGATE_TIMEOUT_MS = 60_000

/** The score a name a human confirmed is worth.
 *
 *  Just under a data-testid and above everything else: somebody looked at the
 *  element and said what it is, which is better evidence than any attribute we
 *  scraped, and worse evidence than an attribute a developer put there
 *  specifically to be selected. */
const CONFIRMED_SCORE = 96

/** Highest score first. Replay walks the list in this order, so the order *is*
 *  the resilience strategy — and every candidate is kept, because the one that
 *  looks redundant today is the one that still resolves after a redeploy. */
const ranked = (selectors: SelectorCandidate[] = []): SelectorCandidate[] =>
  [...selectors].sort((a, b) => b.score - a.score)

/**
 * The selector list for one step: the confirmed name first, then everything the
 * recorder harvested, with duplicates dropped.
 *
 * The confirmed name leads because it is the only one the person would
 * recognise if it stopped working — which matters when a workflow breaks and
 * somebody has to read the step and go and look at the page.
 */
function selectorsFor(step: RecordedStep): SelectorCandidate[] {
  const harvested = ranked(step.selectors)
  if (!step.identifier?.value) return harvested
  const confirmed: SelectorCandidate = { ...step.identifier, score: CONFIRMED_SCORE }
  const rest = harvested.filter(
    (s) => !(s.strategy === confirmed.strategy && s.value === confirmed.value),
  )
  return [confirmed, ...rest]
}

const visible = (selectors: SelectorCandidate[]): WaitCondition => ({ kind: 'visible', selectors })
const hidden = (selectors: SelectorCandidate[]): WaitCondition => ({ kind: 'hidden', selectors })

const KNOWN_KINDS = new Set<StepKind>([
  'navigate',
  'click',
  'type',
  'select',
  'check',
  'uncheck',
  'key',
  'scroll',
  'wait',
  'capture',
  'manual',
])

const label = (step: RecordedStep): string => (step.target ?? '').trim() || 'the element'

/** What a step does, in the words the person who recorded it would use. This is
 *  read by a human at exactly one moment: when the workflow has broken. */
function noteFor(step: RecordedStep, kind: StepKind, mode: ValueMode | undefined, name: string): string {
  const on = label(step)
  switch (kind) {
    case 'navigate':
      return `Open ${step.value ?? 'the page'}`
    case 'click':
      return `Click ${on}`
    case 'type':
      return mode === 'dynamic' ? `Type the ${name} into ${on}` : `Type into ${on}`
    case 'select':
      return mode === 'dynamic' ? `Choose the ${name} in ${on}` : `Choose an option in ${on}`
    case 'check':
      return `Tick ${on}`
    case 'uncheck':
      return `Untick ${on}`
    case 'key':
      return `Press ${step.value ?? 'Enter'}`
    case 'scroll':
      return `Scroll to ${on}`
    case 'wait':
      return step.wait?.kind === 'hidden' ? `Wait for ${on} to go` : `Wait for ${on} to appear`
    case 'capture':
      return `Capture the ${step.capture?.as ?? 'result'} from ${on}`
    case 'manual':
      return `Type the password into ${on} yourself — Atelier never records one`
    default:
      return `${kind} ${on}`
  }
}

export function proposeWorkflow(draft: DraftInput): Workflow {
  const raw = (draft.raw ?? {}) as { startUrl?: string; steps?: RecordedStep[] }
  const recorded = Array.isArray(raw.steps) ? raw.steps : []

  if (!Array.isArray(draft.origins) || draft.origins.length === 0) {
    throw new Error(
      'this recording has no origin, so there is nothing to scope it to — re-record it on the page you want it to act on',
    )
  }
  if (recorded.length === 0) {
    throw new Error(
      'nothing was recorded that can be replayed — start a recording, add at least one step, then save it',
    )
  }

  const steps: Step[] = []

  // Where the recording started. Not a step the person added — they were
  // already on the page — but replay has to get there somehow, and a workflow
  // that assumes the right tab is already open is one that works only for the
  // person who made it.
  if (raw.startUrl) {
    steps.push({
      id: randomUUID(),
      kind: 'navigate',
      selectors: [],
      value: raw.startUrl,
      timeoutMs: NAVIGATE_TIMEOUT_MS,
      note: `Open ${raw.startUrl}`,
    })
  }

  for (const recordedStep of recorded) {
    const kind = (KNOWN_KINDS.has(recordedStep.kind as StepKind) ? recordedStep.kind : 'click') as StepKind
    const selectors = selectorsFor(recordedStep)

    // A secret is never written down. It becomes a step that stops and hands
    // the keyboard back — which is also the only correct behaviour, since a
    // replayed stale password is worse than a pause.
    if (recordedStep.secret || kind === 'manual') {
      steps.push({
        id: randomUUID(),
        kind: 'manual',
        selectors,
        ...(recordedStep.target ? { target: recordedStep.target } : {}),
        timeoutMs: STEP_TIMEOUT_MS,
        note: noteFor(recordedStep, 'manual', undefined, ''),
      })
      continue
    }

    if (kind === 'wait') {
      const condition = recordedStep.wait?.kind === 'hidden' ? hidden(selectors) : visible(selectors)
      steps.push({
        id: randomUUID(),
        kind: 'wait',
        // The condition carries the selector; the step itself acts on nothing,
        // so giving it selectors too would make replay hunt for an element it
        // has no use for.
        selectors: [],
        ...(recordedStep.target ? { target: recordedStep.target } : {}),
        waitBefore: condition,
        timeoutMs: WAIT_TIMEOUT_MS,
        note: noteFor(recordedStep, 'wait', undefined, ''),
      })
      continue
    }

    if (kind === 'capture') {
      const as = recordedStep.capture?.as ?? 'image'
      steps.push({
        id: randomUUID(),
        kind: 'capture',
        selectors,
        ...(recordedStep.target ? { target: recordedStep.target } : {}),
        capture: {
          as,
          from: recordedStep.capture?.from ?? 'auto',
          ...(recordedStep.capture?.attribute ? { attribute: recordedStep.capture.attribute } : {}),
        },
        // The wait the recording cannot contain. At record time the result was
        // already on screen, because the person waited for it before pointing
        // at it. On replay nobody is waiting, so the step has to.
        waitBefore: visible(selectors),
        timeoutMs: CAPTURE_TIMEOUT_MS,
        note: noteFor(recordedStep, 'capture', undefined, ''),
      })
      continue
    }

    if (kind === 'type' || kind === 'select') {
      const mode: ValueMode = recordedStep.valueMode === 'dynamic' ? 'dynamic' : 'static'
      const sample = recordedStep.sampleValue ?? recordedStep.value ?? ''
      const base: Step = {
        id: randomUUID(),
        kind,
        selectors,
        ...(recordedStep.target ? { target: recordedStep.target } : {}),
        valueMode: mode,
        sampleValue: sample,
        timeoutMs: STEP_TIMEOUT_MS,
        value: sample,
        note: '',
      }
      const name = (recordedStep.inputName ?? '').trim() || inputNameFor(base)
      steps.push({
        ...base,
        ...(mode === 'dynamic' ? { inputName: name, value: `{{${name}}}` } : {}),
        note: noteFor(recordedStep, kind, mode, name),
      })
      continue
    }

    steps.push({
      id: randomUUID(),
      kind,
      selectors,
      ...(recordedStep.target ? { target: recordedStep.target } : {}),
      ...(recordedStep.value != null ? { value: recordedStep.value } : {}),
      timeoutMs: STEP_TIMEOUT_MS,
      note: noteFor(recordedStep, kind, undefined, ''),
    })
  }

  const inputs = inputsFrom(steps)
  const captured = steps.find((s) => s.kind === 'capture')
  const producesFromCapture =
    captured?.capture?.as === 'text' ? 'text' : captured?.capture?.as === 'download' ? 'file' : 'image'

  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    // Left blank here on purpose: a proposal is a pure function of a recording
    // and does not get to decide where it lands. saveWorkflow stamps the project
    // when it is persisted.
    projectId: draft.projectId ?? '',
    name: draft.name,
    // The person's own words or nothing at all. There used to be a generated
    // sentence here — "Produces image from prompt by replaying 4 recorded
    // steps" — which restated the mechanics the agent could already see and,
    // worse, made an undescribed workflow indistinguishable from a described
    // one. A summary is composed for display instead, so "nobody has said what
    // this is for" stays a fact the tools can report.
    description: (draft.description ?? '').trim(),
    // Never active. A recording that can run the moment it stops is a recording
    // nobody checked.
    status: 'draft',
    origins: [...draft.origins],
    profileId: null,
    inputs,
    steps,
    produces: captured ? producesFromCapture : 'none',
    // The floor, which is also the default. A page that needs no pause is not
    // harmed by one, and a page that needs it gives no signal to wait on.
    stepDelayMs: 1000,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * What a workflow does, mechanically, for when nobody has said what it is for.
 *
 * Composed at display time rather than stored, which is the whole point: a
 * stored fallback is indistinguishable from a description somebody wrote, so
 * nothing can tell you that a workflow has never been explained. Every figure
 * in it is already in the listing beside it, so it is a last resort and reads
 * like one.
 */
export function summarise(w: {
  /** A whole workflow carries its steps; the listing carries how many. Both
   *  callers are real, and neither should have to reshape itself to ask. */
  steps: number | readonly unknown[]
  inputs: ReadonlyArray<{ name: string }>
  produces: string
}): string {
  const count = Array.isArray(w.steps) ? w.steps.length : (w.steps as number)
  const verb = w.produces === 'none' ? 'Runs' : `Produces ${w.produces}`
  const takes = w.inputs.length ? ` from ${w.inputs.map((i) => i.name).join(', ')}` : ''
  return `${verb}${takes} by replaying ${count} recorded step${count === 1 ? '' : 's'}.`
}

/** The values a test run types: whatever was typed while recording, for every
 *  input the workflow declares. A test with invented inputs tests nothing. */
export function sampleInputs(workflow: Pick<Workflow, 'steps'>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const step of workflow.steps) {
    if (step.valueMode !== 'dynamic') continue
    const name = step.inputName ?? inputNameFor(step)
    out[name] = step.sampleValue ?? ''
  }
  return out
}
