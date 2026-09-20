/**
 * The job state machine.
 *
 * One step is in flight at a time, per job. The daemon sends a step, the
 * extension acks, the daemon advances. That is slower than shipping the whole
 * list, and it is what makes a job resumable from the exact step that failed —
 * which is the entire point of the human-in-the-loop design.
 */
import type { Hub, Client } from '../ws/hub.ts'
import type { ClientMsg } from '../ws/protocol.ts'
import type { Job, Step, Workflow } from '../types.ts'
import * as repo from '../db/repo.ts'
import { proposeWorkflow } from './propose.ts'

/** Substitutes {{name}} from the job's inputs. Unknown placeholders are left
 *  alone rather than blanked, so a typo is visible in the browser instead of
 *  silently sending an empty prompt. */
export function interpolate(value: string, inputs: Record<string, string>): string {
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, key: string) =>
    key in inputs ? inputs[key]! : whole,
  )
}

export interface RunnerDeps {
  hub: Hub
  /** Called whenever job state changes, so the popup can be pushed. */
  onChange: () => void
  /** Ask the OS to raise a notification. Injected so tests don't shell out. */
  notify?: (title: string, body: string) => void
}

export class Runner {
  private inFlight = new Map<string, { workflow: Workflow; client: Client }>()
  private lastEscalated = new Map<string, number>()
  private deps: RunnerDeps

  // Written out rather than as a parameter property so `node
  // --experimental-strip-types` can run this file directly in tests.
  constructor(deps: RunnerDeps) {
    this.deps = deps
    deps.hub.onMessage((msg, client) => this.handle(msg, client))
  }

  /** Queue a job and try to start it immediately. */
  start(workflow: Workflow, inputs: Record<string, string>, isTest = false): Job {
    const job = repo.createJob(workflow.id, inputs, workflow.steps.length, isTest)
    repo.addJobEvent(job.id, 'queued', { inputs, isTest })
    this.pump(job.id)
    return repo.getJob(job.id)!
  }

  resume(jobId: string): Job | null {
    const job = repo.getJob(jobId)
    if (!job || job.status !== 'blocked') return job
    repo.updateJob(jobId, { status: 'queued', blockedReason: null })
    repo.addJobEvent(jobId, 'resumed', { fromStep: job.stepIndex })
    this.pump(jobId)
    return repo.getJob(jobId)
  }

  cancel(jobId: string): Job | null {
    const job = repo.getJob(jobId)
    if (!job || ['done', 'failed', 'cancelled'].includes(job.status)) return job
    repo.updateJob(jobId, { status: 'cancelled' })
    repo.addJobEvent(jobId, 'cancelled')
    const flight = this.inFlight.get(jobId)
    if (flight) this.deps.hub.send(flight.client, { t: 'job.cancelled', jobId })
    this.inFlight.delete(jobId)
    this.deps.onChange()
    return repo.getJob(jobId)
  }

  /** Called when an extension connects — picks up anything parked on "no browser". */
  onClientConnected(): void {
    for (const job of repo.listJobs(['blocked'])) {
      if (job.blockedReason?.startsWith('Waiting for')) this.resume(job.id)
    }
    for (const job of repo.listJobs(['queued'])) this.pump(job.id)
  }

  private block(jobId: string, reason: string): void {
    repo.updateJob(jobId, { status: 'blocked', blockedReason: reason })
    repo.addJobEvent(jobId, 'blocked', { reason })
    this.inFlight.delete(jobId)
    this.deps.notify?.('Atelier needs you', reason)
    this.deps.onChange()
  }

  /**
   * A job parks and notifies once. If the browser was closed, or the
   * notification was dismissed on the way past, nobody is told again and the
   * job waits forever — which reads as "Atelier lost my work". Say it again,
   * periodically, for as long as it is still waiting.
   */
  escalateStaleBlocks(afterMs = 15 * 60 * 1000, now = Date.now()): string[] {
    const nagged: string[] = []
    for (const job of repo.listJobs(['blocked'])) {
      const waitingFor = now - new Date(job.updatedAt).getTime()
      if (waitingFor < afterMs) continue
      const since = Math.round(waitingFor / 60000)
      const last = this.lastEscalated.get(job.id) ?? 0
      if (now - last < afterMs) continue
      this.lastEscalated.set(job.id, now)
      this.deps.notify?.(
        `${job.workflowName} is still waiting`,
        `${job.blockedReason ?? 'Paused.'} (${since} minutes)`,
      )
      nagged.push(job.id)
    }
    return nagged
  }

  /** Send the current step, or finish the job if there are none left. */
  private pump(jobId: string): void {
    const job = repo.getJob(jobId)
    if (!job || !['queued', 'running'].includes(job.status)) return

    const workflow = repo.getWorkflow(job.workflowId)
    if (!workflow) {
      repo.updateJob(jobId, { status: 'failed', error: 'workflow no longer exists' })
      this.deps.onChange()
      return
    }

    if (job.stepIndex >= workflow.steps.length) {
      repo.updateJob(jobId, { status: 'done' })
      repo.addJobEvent(jobId, 'done')
      const flight = this.inFlight.get(jobId)
      if (flight) this.deps.hub.send(flight.client, { t: 'job.done', jobId })
      this.inFlight.delete(jobId)
      this.deps.onChange()
      return
    }

    const client = this.deps.hub.clientFor(workflow.profileId)
    if (!client) {
      const label = workflow.profileId
        ? (repo.getProfile(workflow.profileId)?.label ?? 'the recorded profile')
        : 'a browser'
      this.block(jobId, `Waiting for ${label} — open Chrome with the Atelier extension.`)
      return
    }

    const step = workflow.steps[job.stepIndex]!
    this.inFlight.set(jobId, { workflow, client })
    repo.updateJob(jobId, { status: 'running' })
    repo.addJobEvent(jobId, 'step.start', { index: job.stepIndex, kind: step.kind })

    this.deps.hub.send(client, {
      t: 'job.step',
      jobId,
      stepIndex: job.stepIndex,
      stepCount: workflow.steps.length,
      step: this.materialise(step, job.inputs),
      origins: workflow.origins,
      workflowName: workflow.name,
    })
    this.deps.onChange()
  }

  /** Resolve {{placeholders}} just before sending, never at save time — the
   *  stored workflow stays generic and reusable. */
  private materialise(step: Step, inputs: Record<string, string>): Step {
    if (!step.value) return step
    return { ...step, value: interpolate(step.value, inputs) }
  }

  private handle(msg: ClientMsg, client: Client): void {
    switch (msg.t) {
      case 'step.ok': {
        const job = repo.getJob(msg.jobId)
        if (!job || job.stepIndex !== msg.stepIndex) return // stale ack
        // Which candidate resolved is the only signal that a workflow is
        // decaying. Recorded here rather than in the extension so it survives
        // the extension being a version behind.
        if (msg.matched) {
          const workflow = repo.getWorkflow(job.workflowId)
          const step = workflow?.steps[msg.stepIndex]
          if (workflow && step) {
            repo.recordStepMatch(workflow.id, step.id, msg.matched.strategy, msg.matched.score)
          }
        }
        repo.addJobEvent(msg.jobId, 'step.ok', { index: msg.stepIndex, matched: msg.matched ?? null })
        repo.updateJob(msg.jobId, { stepIndex: msg.stepIndex + 1 })
        this.pump(msg.jobId)
        break
      }
      case 'step.fail': {
        const job = repo.getJob(msg.jobId)
        if (!job || job.stepIndex !== msg.stepIndex) return
        repo.addJobEvent(msg.jobId, 'step.fail', { index: msg.stepIndex, reason: msg.reason })
        if (msg.recoverable) {
          // Park at the same step. Resume retries it rather than skipping it.
          this.block(msg.jobId, msg.reason)
        } else {
          repo.updateJob(msg.jobId, { status: 'failed', error: msg.reason })
          this.inFlight.delete(msg.jobId)
          this.deps.notify?.('Atelier job failed', `${job.workflowName}: ${msg.reason}`)
          this.deps.onChange()
        }
        break
      }
      case 'job.resume':
        this.resume(msg.jobId)
        break
      case 'job.cancel':
        this.cancel(msg.jobId)
        break
      case 'draft.save': {
        const draftId = repo.createDraft({
          name: msg.name,
          profileId: client.profileId,
          origins: msg.origins,
          raw: msg.raw,
        })
        // Propose the workflow now, rather than leaving a draft sitting in the
        // panel with "ask Claude Code to review drafts" under it. The rules
        // that turn a trace into steps are fixed (core/propose.ts), so there is
        // nothing here worth a round trip through another application. The
        // result is saved as `draft` status: visible, editable, and unable to
        // run until a human activates it.
        try {
          const proposed = proposeWorkflow({
            name: msg.name,
            origins: msg.origins,
            raw: msg.raw,
            ...(msg.description ? { description: msg.description } : {}),
          })
          const existing = repo.getWorkflowByName(proposed.name)
          const saved = repo.saveWorkflow({
            ...proposed,
            ...(existing ? { id: existing.id } : {}),
            profileId: client.profileId,
          })
          repo.markDraftReviewed(draftId)
          this.deps.hub.send(client, {
            t: 'workflow.proposed',
            name: saved.name,
            steps: saved.steps.length,
            inputs: saved.inputs.map((i) => i.name),
            produces: saved.produces,
          })
        } catch (e) {
          // A recording we cannot turn into a workflow stays a draft rather
          // than disappearing. The panel shows why.
          this.deps.notify?.('Atelier could not use that recording', (e as Error).message)
        }
        this.deps.onChange()
        break
      }

      case 'step.repoint': {
        // Repairing one step of a workflow whose page moved, without
        // re-recording the other nineteen. Only where the step *looks*: the
        // action it performs is what the person demonstrated and is not
        // re-opened here.
        const workflow = repo.getWorkflowByName(msg.workflowName)
        if (!workflow) break
        try {
          repo.replaceStep(workflow.id, msg.stepId, stepFromPick(msg.pick))
        } catch (e) {
          this.deps.notify?.('Atelier could not repoint that step', (e as Error).message)
        }
        this.deps.onChange()
        break
      }
      default:
        break
    }
  }
}

/**
 * One re-pointed element → the fields of a step.
 *
 * Deliberately narrow: it replaces how the step *finds* its element and what
 * the person calls it, and leaves everything else — kind, value, waits,
 * timeout — alone. Those were decided when the workflow was made, and the page
 * moving does not invalidate any of them.
 */
export function stepFromPick(pick: unknown): Partial<Step> {
  const p = (pick ?? {}) as {
    target?: string
    identifier?: { strategy: string; value: string; score: number } | null
    selectors?: Array<{ strategy: string; value: string; score: number }>
  }
  const harvested = [...(p.selectors ?? [])].sort((x, y) => y.score - x.score)
  const confirmed = p.identifier?.value
    ? [{ ...p.identifier, score: 96 } as Step['selectors'][number]]
    : []
  const selectors = [
    ...confirmed,
    ...harvested.filter(
      (s) => !confirmed.some((c) => c.strategy === s.strategy && c.value === s.value),
    ),
  ] as Step['selectors']
  if (selectors.length === 0) {
    throw new Error('that element could not be identified — point at the control itself')
  }
  const patch: Partial<Step> = { selectors }
  if (p.target) patch.target = p.target
  return patch
}
