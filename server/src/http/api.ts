/**
 * The daemon's control API. Consumed only by the MCP process, over loopback.
 *
 * This is deliberately HTTP rather than a unix socket: same port as the
 * extension's WebSocket, one thing to discover, and it works identically on
 * every OS.
 */
import type { Runner } from '../core/runner.ts'
import type { Hub } from '../ws/hub.ts'
import * as repo from '../db/repo.ts'
import * as assets from '../core/assets.ts'
import { assessWorkflow } from '../core/health.ts'
import { proposeWorkflow } from '../core/propose.ts'
import type { Workflow } from '../types.ts'

export interface ApiDeps {
  hub: Hub
  runner: Runner
  version: string
  /** The dashboard/panel snapshot. Injected because the daemon owns uptime and
   *  the log tail, which do not belong in the repo layer. */
  overview: () => unknown
}

type Handler = (body: any, deps: ApiDeps) => unknown

/**
 * Verbs that only read. Everything else changes something, and the dashboard
 * and side panel have to be told.
 *
 * Framed this way round on purpose: a new route that mutates and forgets to
 * announce it is a control that silently does nothing, which is precisely what
 * happened — Delete and Activate both worked and neither refreshed, so the
 * dashboard sat on stale data until the 25-second heartbeat came round.
 * Read-only is the exception you have to opt into.
 */
const READ_ONLY = new Set(['list', 'get', 'status', 'health'])

export function mutates(path: string): boolean {
  const verb = path.split('.').pop() ?? ''
  return !READ_ONLY.has(verb)
}

const missing = (name: string) => {
  throw new Error(`${name} is required`)
}

export const routes: Record<string, Handler> = {
  '/api/health': (_b, d) => ({
    ok: true,
    version: d.version,
    browsers: d.hub.connected().map((c) => ({ profileId: c.profileId, label: c.label })),
  }),

  /** Everything a client needs to render: status, jobs, workflows, assets.
   *  The dashboard streams this over SSE; the side panel polls it. */
  '/api/overview': (_b, d) => d.overview(),

  '/api/jobs.resume': (b, d) => ({ job: d.runner.resume(b?.id ?? missing('id')) }),

  '/api/workflows.list': (b) => {
    const all = repo.listWorkflows(b?.status)
    return {
      workflows: all.map((w) => {
        const health = assessWorkflow(w, repo.stepMatches(w.id))
        return {
          name: w.name,
          description: w.description,
          status: w.status,
          produces: w.produces,
          inputs: w.inputs,
          origins: w.origins,
          steps: w.steps.length,
          health: { state: health.state, summary: health.summary, degraded: health.degraded.length },
        }
      }),
    }
  },

  '/api/workflows.get': (b) => {
    const w = repo.getWorkflowByName(b?.name ?? missing('name'))
    if (!w) throw new Error(`no workflow named ${b.name}`)
    return { workflow: w, health: assessWorkflow(w, repo.stepMatches(w.id)) }
  },

  /** Full health detail, step by step. Separate from workflows.get because the
   *  common question is "is anything rotting", not "show me every step". */
  '/api/workflows.health': (b) => {
    if (b?.name) {
      const w = repo.getWorkflowByName(b.name)
      if (!w) throw new Error(`no workflow named ${b.name}`)
      return { workflows: [{ name: w.name, ...assessWorkflow(w, repo.stepMatches(w.id)) }] }
    }
    return {
      workflows: repo.listWorkflows().map((w) => ({
        name: w.name,
        ...assessWorkflow(w, repo.stepMatches(w.id)),
      })),
    }
  },

  /** Activate a proposed workflow. This is the human confirmation that a
   *  recording is allowed to run — nothing else flips a workflow to active. */
  '/api/workflows.activate': (b) => {
    const name = b?.name ?? missing('name')
    const w = repo.getWorkflowByName(name)
    if (!w) throw new Error(`no workflow named ${name}`)
    if (!w.steps.length) throw new Error(`workflow "${name}" has no steps to run`)
    return { workflow: repo.saveWorkflow({ ...w, status: 'active' }) }
  },

  /** Edit one step in place. The repair path for a workflow whose page moved:
   *  the other nineteen steps were reviewed once and are still fine. */
  '/api/workflows.replaceStep': (b) => {
    const name = b?.name ?? missing('name')
    const stepId = b?.stepId ?? missing('stepId')
    const w = repo.getWorkflowByName(name)
    if (!w) throw new Error(`no workflow named ${name}`)
    return { workflow: repo.replaceStep(w.id, stepId, b?.step ?? {}) }
  },

  '/api/workflows.removeStep': (b) => {
    const name = b?.name ?? missing('name')
    const stepId = b?.stepId ?? missing('stepId')
    const w = repo.getWorkflowByName(name)
    if (!w) throw new Error(`no workflow named ${name}`)
    return { workflow: repo.removeStep(w.id, stepId) }
  },

  /** Re-propose from the original recording. Useful when the proposal rules
   *  improved after a workflow was made. */
  '/api/drafts.repropose': (b) => {
    const d = repo.getDraft(b?.id ?? missing('id'))
    if (!d) throw new Error(`no draft ${b.id}`)
    const proposed = proposeWorkflow({ name: d.name, origins: d.origins, raw: d.raw })
    const existing = repo.getWorkflowByName(proposed.name)
    return {
      workflow: repo.saveWorkflow({
        ...proposed,
        ...(existing ? { id: existing.id } : {}),
        profileId: d.profileId,
      }),
    }
  },

  '/api/workflows.save': (b) => {
    const w = b?.workflow as Workflow | undefined
    if (!w?.name) missing('workflow.name')
    if (!Array.isArray(w!.origins) || w!.origins.length === 0) {
      // Not a nicety: without an origin allowlist a workflow can act on whatever
      // tab happens to be focused.
      throw new Error('workflow.origins must list at least one origin')
    }
    const existing = repo.getWorkflowByName(w!.name)
    const saved = repo.saveWorkflow({ ...w!, ...(existing ? { id: existing.id } : {}) })
    return { workflow: saved }
  },

  '/api/workflows.delete': (b) => {
    const name = b?.name ?? missing('name')
    const w = repo.getWorkflowByName(name)
    if (!w) throw new Error(`no workflow named ${name}`)
    repo.deleteWorkflow(w.id)
    return { deleted: name }
  },

  '/api/drafts.delete': (b) => {
    const id = b?.id ?? missing('id')
    if (!repo.deleteDraft(id)) throw new Error(`no draft ${id}`)
    return { deleted: id }
  },

  '/api/workflows.run': (b, d) => {
    const name = b?.name ?? missing('name')
    const w = repo.getWorkflowByName(name)
    if (!w) throw new Error(`no workflow named ${name}`)
    if (w.status !== 'active') {
      throw new Error(`workflow "${name}" is ${w.status}; only active workflows can run`)
    }
    const inputs: Record<string, string> = b?.inputs ?? {}
    for (const spec of w.inputs) {
      if (spec.required && !inputs[spec.name]) throw new Error(`input "${spec.name}" is required`)
    }
    return { job: d.runner.start(w, inputs) }
  },

  '/api/jobs.status': (b) => {
    const job = repo.getJob(b?.id ?? missing('id'))
    if (!job) throw new Error(`no job ${b.id}`)
    return { job, events: repo.jobEvents(job.id) }
  },

  '/api/jobs.list': (b) => ({ jobs: repo.listJobs(b?.statuses, b?.limit ?? 20) }),

  '/api/jobs.cancel': (b, d) => ({ job: d.runner.cancel(b?.id ?? missing('id')) }),

  '/api/assets.list': (b) => ({ assets: repo.listAssets(b?.limit ?? 20, b?.tag) }),

  '/api/assets.get': (b) => {
    const a = repo.getAsset(b?.id ?? missing('id'))
    if (!a) throw new Error(`no asset ${b.id}`)
    return { asset: a }
  },

  '/api/assets.attach': (b) => {
    const a = repo.getAsset(b?.id ?? missing('id'))
    if (!a) throw new Error(`no asset ${b.id}`)
    const dest = b?.path ?? missing('path')
    assets.attach(a, dest)
    return { asset: a, path: dest }
  },

  '/api/drafts.list': () => ({ drafts: repo.listDrafts(true) }),

  '/api/drafts.get': (b) => {
    const d = repo.getDraft(b?.id ?? missing('id'))
    if (!d) throw new Error(`no draft ${b.id}`)
    return { draft: d }
  },

  '/api/drafts.promote': (b) => {
    const draft = repo.getDraft(b?.draftId ?? missing('draftId'))
    if (!draft) throw new Error(`no draft ${b.draftId}`)
    const w = b?.workflow as Workflow | undefined
    if (!w?.name) missing('workflow')
    if (!Array.isArray(w!.origins) || w!.origins.length === 0) {
      throw new Error('workflow.origins must list at least one origin')
    }
    const saved = repo.saveWorkflow({
      ...w!,
      profileId: draft.profileId,
      status: w!.status ?? 'active',
    })
    repo.markDraftReviewed(draft.id)
    return { workflow: saved }
  },
}
