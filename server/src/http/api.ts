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
import type { Workflow } from '../types.ts'

export interface ApiDeps {
  hub: Hub
  runner: Runner
  version: string
}

type Handler = (body: any, deps: ApiDeps) => unknown

const missing = (name: string) => {
  throw new Error(`${name} is required`)
}

export const routes: Record<string, Handler> = {
  '/api/health': (_b, d) => ({
    ok: true,
    version: d.version,
    browsers: d.hub.connected().map((c) => ({ profileId: c.profileId, label: c.label })),
  }),

  '/api/workflows.list': (b) => {
    const all = repo.listWorkflows(b?.status)
    return {
      workflows: all.map((w) => ({
        name: w.name,
        description: w.description,
        status: w.status,
        produces: w.produces,
        inputs: w.inputs,
        origins: w.origins,
        steps: w.steps.length,
      })),
    }
  },

  '/api/workflows.get': (b) => {
    const w = repo.getWorkflowByName(b?.name ?? missing('name'))
    if (!w) throw new Error(`no workflow named ${b.name}`)
    return { workflow: w }
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
