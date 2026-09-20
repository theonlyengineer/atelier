/**
 * A workflow's signature, derived from its steps.
 *
 * Its own module because two layers need it and neither should own it: the
 * proposal pass builds a workflow's inputs when a recording is saved, and the
 * repo rebuilds them when somebody flips one value from static to dynamic
 * afterwards. Both have to agree, so there is one copy of the rule.
 *
 * Pure — no database, no clock, no randomness.
 */
import type { Step, WorkflowInput } from '../types.ts'

/**
 * What a name becomes once it is written down.
 *
 * The one place that decides it, because the decision is what makes two names
 * the same name: "Same text", "SAME Text" and "same_text" all serialise to
 * `same_text`, and an agent handed that workflow would see one input where the
 * person thought they had made two.
 */
export function inputKey(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
}

/**
 * The name a dynamic value is asked for under.
 *
 * Derived from what the person called the field when they pointed at it, so the
 * agent-facing name of an input is the same word the human used.
 */
export function inputNameFor(step: Pick<Step, 'target'>): string {
  return inputKey(step.target) || 'value'
}

/** The name a step actually asks for, whichever way it was given one. */
export const askedName = (step: Pick<Step, 'target' | 'inputName'>): string =>
  inputKey(step.inputName) || inputNameFor(step)

/**
 * A step already asking for this name, if there is one.
 *
 * Two dynamic fields cannot share a name: the caller passes one value and both
 * fields would receive it, which is silently not what anybody drawing two boxes
 * meant. It is refused where the name is given rather than repaired afterwards,
 * because the person is right there and renaming is free.
 *
 * `exceptId` is the step being edited — a step is allowed to keep the name it
 * already has, and to be given a differently-spelled version of it.
 */
export function nameClash(
  steps: Step[],
  name: string,
  exceptId?: string,
): Step | null {
  const key = inputKey(name)
  if (!key) return null
  return (
    steps.find(
      (step) => step.id !== exceptId && step.valueMode === 'dynamic' && askedName(step) === key,
    ) ?? null
  )
}

/**
 * A workflow's declared inputs are exactly its dynamic steps, in order.
 *
 * Derived rather than stored twice, so the signature cannot drift from the steps
 * it describes. The deduplication below should never fire now that a clash is
 * refused where the name is given; it stays as the last resort for a workflow
 * recorded by an older extension, where collapsing two fields onto one input is
 * at least better than declaring the same input twice.
 */
export function inputsFrom(steps: Step[]): WorkflowInput[] {
  const seen = new Set<string>()
  const out: WorkflowInput[] = []
  for (const step of steps) {
    if (step.valueMode !== 'dynamic') continue
    const name = step.inputName ?? inputNameFor(step)
    if (seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      description: `Text typed into ${step.target ?? 'the field'}. Composed by the caller and passed whole.`,
      required: true,
    })
  }
  return out
}
