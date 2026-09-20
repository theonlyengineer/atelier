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
import { proposeWorkflow, sampleInputs } from '../core/propose.ts'
import type { Workflow, WorkflowStatus } from '../types.ts'

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
 * and popup have to be told.
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
  /* ------------------------------------------------------------ projects */

  '/api/projects.list': () => ({
    projects: repo.listProjects().map((p) => ({ ...p, contents: repo.projectContents(p.id) })),
    active: repo.activeProject(),
  }),

  '/api/projects.create': (b) => ({ project: repo.createProject(b?.name ?? missing('name'), b?.note) }),

  /** Issue a new token for a project, invalidating every config file that
   *  carries the old one. The only way to revoke access, so it is a button
   *  somebody presses rather than anything automatic. */
  '/api/projects.rotateToken': (b) => ({
    project: repo.rotateProjectToken(b?.id ?? missing('id')),
  }),

  '/api/projects.rename': (b) => ({
    project: repo.renameProject(b?.id ?? missing('id'), b?.name ?? missing('name')),
  }),

  /** The switch. Everything the dashboard and the extension show follows this. */
  '/api/projects.activate': (b) => ({ project: repo.setActiveProject(b?.id ?? missing('id')) }),

  '/api/projects.delete': (b) => {
    const id = b?.id ?? missing('id')
    if (!repo.deleteProject(id)) throw new Error(`no project ${id}`)
    return { deleted: id }
  },

  '/api/health': (_b, d) => ({
    ok: true,
    version: d.version,
    browsers: d.hub.connected().map((c) => ({ profileId: c.profileId, label: c.label })),
  }),

  /** Everything a client needs to render: status, jobs, workflows, assets.
   *  The dashboard streams this over SSE; the popup polls it. */
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
    return { workflow: repo.setWorkflowStatus(w.id, 'active') }
  },

  /** Say what a workflow is for. The one thing about it that cannot be derived
   *  from the recording, and the only thing that tells an agent when to reach
   *  for it rather than what it will do once it has. */
  '/api/workflows.setDescription': (b) => {
    const name = b?.name ?? missing('name')
    const w = repo.getWorkflowByName(name)
    if (!w) throw new Error(`no workflow named ${name}`)
    return { workflow: repo.setWorkflowDescription(w.id, b?.description ?? null) }
  },

  /**
   * Turn a workflow off without deleting it.
   *
   * A disabled workflow is invisible to the agent and to the popup and refuses
   * to run, but keeps its steps, its history and its health. It is the honest
   * middle between "this is fine" and "this is gone" — a site changed, the
   * workflow is broken for now, and nobody wants to re-record it from scratch
   * to find that out.
   */
  '/api/workflows.setStatus': (b) => {
    const name = b?.name ?? missing('name')
    const status = (b?.status ?? missing('status')) as WorkflowStatus
    if (!['draft', 'active', 'disabled'].includes(status)) {
      throw new Error(`"${status}" is not a workflow status`)
    }
    const w = repo.getWorkflowByName(name)
    if (!w) throw new Error(`no workflow named ${name}`)
    return { workflow: repo.setWorkflowStatus(w.id, status) }
  },

  /**
   * Change one step's value: static or dynamic, and what a test run types.
   *
   * The only edit a recorded workflow accepts. The action a step performs is
   * what the person demonstrated and is not re-openable — a workflow whose
   * steps can be rewritten into something nobody ever performed is a workflow
   * nobody checked.
   */
  '/api/workflows.setStepValue': (b) => {
    const name = b?.name ?? missing('name')
    const stepId = b?.stepId ?? missing('stepId')
    const w = repo.getWorkflowByName(name)
    if (!w) throw new Error(`no workflow named ${name}`)
    return {
      workflow: repo.setStepValue(w.id, stepId, {
        ...(b?.valueMode ? { valueMode: b.valueMode } : {}),
        ...(typeof b?.sampleValue === 'string' ? { sampleValue: b.sampleValue } : {}),
        ...(b?.inputName ? { inputName: b.inputName } : {}),
      }),
    }
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

  /**
   * Run a workflow with the values it was recorded with.
   *
   * The point of keeping a sample value on a dynamic step: checking that a
   * workflow still works should not require inventing a plausible-looking
   * prompt, and a test that types something the person never typed is testing a
   * different workflow. Allowed on a draft as well as an active one — trying it
   * before allowing it to run is the whole reason to try it.
   */
  '/api/workflows.test': (b, d) => {
    const name = b?.name ?? missing('name')
    const w = repo.getWorkflowByName(name)
    if (!w) throw new Error(`no workflow named ${name}`)
    if (w.status === 'disabled') throw new Error(`workflow "${name}" is disabled — enable it first`)
    return { job: d.runner.start(w, sampleInputs(w), true) }
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

  '/api/assets.describe': (b) => {
    const id = b?.id ?? missing('id')
    const asset = repo.setAssetDescription(id, b?.description ?? null)
    if (!asset) throw new Error(`no asset ${id}`)
    return { asset }
  },

  '/api/assets.delete': (b) => {
    const id = b?.id ?? missing('id')
    if (!assets.remove(id)) throw new Error(`no asset ${id}`)
    return { deleted: id }
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
