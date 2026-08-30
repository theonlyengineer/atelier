/**
 * Whether a workflow is still finding things the way it was recorded to.
 *
 * Replay tries selector candidates best-first and uses whichever resolves. That
 * fallback is what makes a workflow survive a redeploy — and it is also what
 * hides the redeploy, because a step quietly matching on a positional XPath
 * looks identical, from the outside, to one matching on the data-testid it was
 * recorded with. It works, until the day the position moves too.
 *
 * So replay now reports which candidate won, and this decides what that means.
 * The point is to say "this will break" before it does.
 */
import type { SelectorStrategy, Step, Workflow } from '../types.ts'

/** What actually matched, last time this step ran. */
export interface StepMatch {
  stepId: string
  strategy: SelectorStrategy
  score: number
  at: string
}

export type HealthState = 'ok' | 'unknown' | 'degraded' | 'fragile'

export interface StepHealth {
  stepId: string
  note: string
  state: HealthState
  /** One sentence a human can act on. */
  detail: string
  recordedStrategy: SelectorStrategy | null
  matchedStrategy: SelectorStrategy | null
  at: string | null
}

export interface WorkflowHealth {
  state: HealthState
  summary: string
  steps: StepHealth[]
  /** Only the ones worth showing — degraded or fragile, worst first. */
  degraded: StepHealth[]
}

/**
 * Below this, a selector is describing where an element sits rather than what
 * it is. `css` (40) and `xpath` (30) are both positional; `text` (60) is the
 * lowest identity-bearing strategy. A step matching below the line still works
 * and is still the next one to break.
 */
const POSITIONAL_BELOW = 60

const RANK: Record<HealthState, number> = { ok: 0, unknown: 1, degraded: 2, fragile: 3 }

/** Steps that look nothing up have no health to report. Counting them would
 *  make every workflow look healthier than it is. */
const looksUp = (step: Step): boolean => (step.selectors?.length ?? 0) > 0

const describeStrategy = (s: SelectorStrategy): string =>
  s === 'xpath' || s === 'css' ? 'position in the page' : `its ${s}`

export function assessWorkflow(
  workflow: Pick<Workflow, 'name' | 'steps'>,
  matches: StepMatch[],
): WorkflowHealth {
  const byStep = new Map(matches.map((m) => [m.stepId, m]))
  const assessed = (workflow.steps ?? []).filter(looksUp)

  const steps: StepHealth[] = assessed.map((step) => {
    const best = [...step.selectors].sort((a, b) => b.score - a.score)[0]!
    const match = byStep.get(step.id)
    const note = step.note ?? step.kind

    if (!match) {
      return {
        stepId: step.id,
        note,
        state: 'unknown',
        detail: 'Has not run yet, so there is nothing to compare against.',
        recordedStrategy: best.strategy,
        matchedStrategy: null,
        at: null,
      }
    }

    const stillOffered = step.selectors.some((s) => s.strategy === match.strategy)
    const state: HealthState =
      match.strategy === best.strategy && stillOffered
        ? 'ok'
        : match.score < POSITIONAL_BELOW || !stillOffered
          ? 'fragile'
          : 'degraded'

    const detail =
      state === 'ok'
        ? `Matching on ${describeStrategy(best.strategy)}, as recorded.`
        : !stillOffered
          ? `Last matched on a ${match.strategy} selector this step no longer carries — it was edited after that run, so treat this as unverified.`
          : `Recorded against ${describeStrategy(best.strategy)}, now matching on ${describeStrategy(match.strategy)}. ${
              state === 'fragile'
                ? 'That is the last candidate before this step stops resolving.'
                : 'Still resolving, but the page has moved under it.'
            }`

    return {
      stepId: step.id,
      note,
      state,
      detail,
      recordedStrategy: best.strategy,
      matchedStrategy: match.strategy,
      at: match.at,
    }
  })

  const degraded = steps
    .filter((s) => s.state === 'degraded' || s.state === 'fragile')
    .sort((a, b) => RANK[b.state] - RANK[a.state])

  const state = steps.reduce<HealthState>(
    (worst, s) => (RANK[s.state] > RANK[worst] ? s.state : worst),
    'ok',
  )

  return { state, summary: summarise(steps, degraded, state), steps, degraded }
}

function summarise(steps: StepHealth[], degraded: StepHealth[], state: HealthState): string {
  const total = steps.length
  if (total === 0) return 'Nothing in this workflow looks an element up.'
  if (state === 'unknown') {
    const ran = steps.filter((s) => s.state !== 'unknown').length
    return ran === 0
      ? `Never run — ${total} step${total === 1 ? '' : 's'} still to be verified.`
      : `${total - ran} of ${total} steps have not run yet.`
  }
  if (degraded.length === 0) return `Healthy: all ${total} steps matched on the selector they were recorded with.`

  const positional = degraded.filter((s) => s.matchedStrategy === 'xpath' || s.matchedStrategy === 'css').length
  const lead = `${degraded.length} of ${total} steps are matching on a weaker selector than recorded`
  return positional > 0
    ? `${lead} — ${positional} of them on position in the page, which will break when the layout next changes.`
    : `${lead}. Still working, but the page has moved under this workflow.`
}
