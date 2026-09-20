/**
 * Typed data access. Everything that touches SQL lives here so the rest of the
 * server deals in the shapes from types.ts and nothing else.
 */
import { randomUUID } from 'node:crypto'
import { newToken, open, nowIso } from './index.ts'
import type { Asset, Job, JobStatus, Step, Workflow, WorkflowStatus } from '../types.ts'
import type { StepMatch } from '../core/health.ts'
import { askedName, inputsFrom, inputKey, inputNameFor, nameClash } from '../core/inputs.ts'

/** node:sqlite rejects `undefined`; JSON round-trips turn absent fields into it. */
const nz = <T>(v: T | undefined | null): T | null => (v === undefined ? null : v)

const j = <T>(s: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(s)) as T
  } catch {
    return fallback
  }
}

/* ---------------------------------------------------------------- projects */

export interface Project {
  id: string
  name: string
  slug: string
  note: string | null
  /** The bearer token an agent presents on /mcp to work in this project. */
  token: string
  createdAt: string
}

const rowToProject = (r: Record<string, unknown>): Project => ({
  id: String(r.id),
  name: String(r.name),
  slug: String(r.slug),
  note: r.note ? String(r.note) : null,
  token: String(r.token ?? ''),
  createdAt: String(r.created_at),
})

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

export function listProjects(): Project[] {
  return (open().prepare(`SELECT * FROM project ORDER BY created_at`).all() as Array<
    Record<string, unknown>
  >).map(rowToProject)
}

export function getProject(id: string): Project | null {
  const r = open().prepare(`SELECT * FROM project WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return r ? rowToProject(r) : null
}

export function getProjectBySlug(slug: string): Project | null {
  const r = open().prepare(`SELECT * FROM project WHERE slug = ?`).get(slug) as
    | Record<string, unknown>
    | undefined
  return r ? rowToProject(r) : null
}

/**
 * The project everything defaults into.
 *
 * Never null: the migration guarantees one exists and that `active_project`
 * points at it, because a daemon with no active project has no answer to "where
 * does this go" — and silently inventing one at write time is how work gets
 * misfiled.
 */
/**
 * A scope for the duration of one synchronous call.
 *
 * The daemon has one active project, but a single request may ask about another
 * — an agent session bound to a different project, say. Rather than thread a
 * projectId through forty call sites, a request sets the scope around its
 * handler and clears it afterwards. Safe because every handler is synchronous:
 * there is no await between the set and the clear for another request to slip
 * into. If a handler ever becomes async, this needs AsyncLocalStorage instead.
 */
let scopeOverride: string | null = null

export function withProject<T>(projectId: string | null | undefined, fn: () => T): T {
  const previous = scopeOverride
  scopeOverride = projectId && getProject(projectId) ? projectId : null
  try {
    return fn()
  } finally {
    scopeOverride = previous
  }
}

export function activeProject(): Project {
  if (scopeOverride) {
    const scoped = getProject(scopeOverride)
    if (scoped) return scoped
  }
  const row = open().prepare(`SELECT value FROM meta WHERE key = 'active_project'`).get() as
    | { value: string }
    | undefined
  const found = row ? getProject(row.value) : null
  if (found) return found
  const first = listProjects()[0]
  if (!first) throw new Error('no projects exist — the database was not migrated')
  setActiveProject(first.id)
  return first
}

export function setActiveProject(id: string): Project {
  const project = getProject(id)
  if (!project) throw new Error(`no project ${id}`)
  open()
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('active_project', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(id)
  return project
}

export function createProject(name: string, note?: string): Project {
  const trimmed = (name ?? '').trim()
  if (!trimmed) throw new Error('a project needs a name')
  const slug = slugify(trimmed)
  if (!slug) throw new Error('a project needs a name with at least one letter or digit')
  if (getProjectBySlug(slug)) throw new Error(`a project called "${slug}" already exists`)

  const id = randomUUID()
  open()
    .prepare(`INSERT INTO project (id, name, slug, note, token, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, trimmed, slug, nz(note), newToken(), nowIso())
  return getProject(id)!
}

/**
 * The project a bearer token belongs to.
 *
 * This is the whole of "which project is this agent working in": the token that
 * got it through the door already says, so nothing downstream has to ask. A
 * token that matches nothing returns null and the request is refused — there is
 * no fallback to the active project, because an unknown credential resolving to
 * *some* project is how one client's work ends up in another's.
 */
export function projectByToken(token: string): Project | null {
  const trimmed = (token ?? '').trim()
  if (!trimmed) return null
  const r = open().prepare(`SELECT * FROM project WHERE token = ?`).get(trimmed) as
    | Record<string, unknown>
    | undefined
  return r ? rowToProject(r) : null
}

/** Issue a new token, invalidating every config file carrying the old one. The
 *  only way to revoke, which is why it is a deliberate button and not a sweep. */
export function rotateProjectToken(id: string): Project {
  const project = getProject(id)
  if (!project) throw new Error(`no project ${id}`)
  open().prepare(`UPDATE project SET token = ? WHERE id = ?`).run(newToken(), id)
  return getProject(id)!
}

export function renameProject(id: string, name: string): Project {
  const trimmed = (name ?? '').trim()
  if (!trimmed) throw new Error('a project needs a name')
  const project = getProject(id)
  if (!project) throw new Error(`no project ${id}`)
  const slug = slugify(trimmed)
  const clash = getProjectBySlug(slug)
  if (clash && clash.id !== id) throw new Error(`a project called "${slug}" already exists`)
  // The id does not change, so nothing inside the project has to move.
  open().prepare(`UPDATE project SET name = ?, slug = ? WHERE id = ?`).run(trimmed, slug, id)
  return getProject(id)!
}

/** What a project holds, for the "are you sure" that precedes deleting it. */
export function projectContents(id: string): { workflows: number; jobs: number; assets: number; drafts: number } {
  const db = open()
  const count = (table: string) =>
    Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(id) as { n: number }).n)
  return {
    workflows: count('workflow'),
    jobs: count('job'),
    assets: count('asset'),
    drafts: count('draft'),
  }
}

export function deleteProject(id: string): boolean {
  const project = getProject(id)
  if (!project) return false
  if (listProjects().length <= 1) throw new Error('this is the only project — there has to be somewhere to be')
  if (activeProject().id === id) throw new Error('this is the active project — switch to another one first')

  const held = projectContents(id)
  const total = held.workflows + held.jobs + held.assets + held.drafts
  if (total > 0) {
    throw new Error(
      `"${project.name}" is not empty — it holds ${held.workflows} workflows, ${held.jobs} runs, ` +
        `${held.assets} assets and ${held.drafts} recordings. Move or delete those first.`,
    )
  }
  return open().prepare(`DELETE FROM project WHERE id = ?`).run(id).changes > 0
}

/* ---------------------------------------------------------------- profiles */

export function upsertProfile(id: string, label: string, profileDir?: string): void {
  const db = open()
  db.prepare(
    `INSERT INTO profile (id, label, profile_dir, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label,
       profile_dir = COALESCE(excluded.profile_dir, profile.profile_dir),
       last_seen_at = excluded.last_seen_at`,
  ).run(id, label, profileDir ?? null, nowIso())
}

export function getProfile(id: string) {
  return open().prepare(`SELECT * FROM profile WHERE id = ?`).get(id) as
    | { id: string; label: string; profile_dir: string | null }
    | undefined
}

/* --------------------------------------------------------------- workflows */

function rowToWorkflow(r: Record<string, unknown>): Workflow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    name: String(r.name),
    description: String(r.description ?? ''),
    status: String(r.status) as WorkflowStatus,
    origins: j<string[]>(r.origins, []),
    profileId: r.profile_id ? String(r.profile_id) : null,
    inputs: j<Workflow['inputs']>(r.inputs, []),
    steps: j<Workflow['steps']>(r.steps, []),
    produces: String(r.produces) as Workflow['produces'],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

/** Every read is scoped to one project. The default is the active one, so a
 *  caller that does not care cannot accidentally see across all of them. */
export function listWorkflows(status?: WorkflowStatus, projectId = activeProject().id): Workflow[] {
  const db = open()
  const rows = status
    ? db
        .prepare(`SELECT * FROM workflow WHERE project_id = ? AND status = ? ORDER BY name`)
        .all(projectId, status)
    : db.prepare(`SELECT * FROM workflow WHERE project_id = ? ORDER BY name`).all(projectId)
  return (rows as Record<string, unknown>[]).map(rowToWorkflow)
}

/** Names are unique per project, so a lookup by name is a lookup *within* one.
 *  A workflow in another project is not found, rather than found by surprise. */
export function getWorkflowByName(name: string, projectId = activeProject().id): Workflow | null {
  const r = open()
    .prepare(`SELECT * FROM workflow WHERE project_id = ? AND name = ?`)
    .get(projectId, name)
  return r ? rowToWorkflow(r as Record<string, unknown>) : null
}

export function getWorkflow(id: string): Workflow | null {
  const r = open().prepare(`SELECT * FROM workflow WHERE id = ?`).get(id)
  return r ? rowToWorkflow(r as Record<string, unknown>) : null
}

/** Deleting a workflow leaves its jobs and assets: they are history, and the
 *  prompt that produced an image is worth keeping after the recipe is gone. */
export function deleteWorkflow(id: string): boolean {
  const db = open()
  const jobs = db.prepare(`SELECT id FROM job WHERE workflow_id = ?`).all(id) as { id: string }[]
  for (const j of jobs) {
    db.prepare(`DELETE FROM job_event WHERE job_id = ?`).run(j.id)
    db.prepare(`UPDATE asset SET job_id = NULL WHERE job_id = ?`).run(j.id)
    db.prepare(`DELETE FROM job WHERE id = ?`).run(j.id)
  }
  const res = db.prepare(`DELETE FROM workflow WHERE id = ?`).run(id)
  return Number(res.changes) > 0
}

export function deleteDraft(id: string): boolean {
  const res = open().prepare(`DELETE FROM draft WHERE id = ?`).run(id)
  return Number(res.changes) > 0
}

export function saveWorkflow(
  w: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
): Workflow {
  const db = open()
  const at = nowIso()
  const id = w.id ?? randomUUID()
  db.prepare(
    `INSERT INTO workflow (id, project_id, name, description, status, origins, profile_id, inputs, steps, produces, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, description = excluded.description, status = excluded.status,
       origins = excluded.origins, profile_id = excluded.profile_id, inputs = excluded.inputs,
       steps = excluded.steps, produces = excluded.produces, updated_at = excluded.updated_at`,
  ).run(
    id,
    // The project a workflow is saved into is decided once, when it is made.
    // An update keeps whatever it already had rather than dragging it to
    // wherever the caller happens to be standing.
    (w.projectId || undefined) ?? getWorkflow(id)?.projectId ?? activeProject().id,
    w.name,
    w.description ?? '',
    w.status ?? 'draft',
    JSON.stringify(w.origins ?? []),
    nz(w.profileId),
    JSON.stringify(w.inputs ?? []),
    JSON.stringify(w.steps ?? []),
    w.produces ?? 'none',
    at,
    at,
  )
  return getWorkflow(id)!
}

/* -------------------------------------------------------------------- jobs */

function rowToJob(r: Record<string, unknown>, assetIds: string[] = []): Job {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    workflowId: String(r.workflow_id),
    workflowName: String(r.workflow_name ?? ''),
    inputs: j<Record<string, string>>(r.inputs, {}),
    status: String(r.status) as JobStatus,
    stepIndex: Number(r.step_index),
    stepCount: Number(r.step_count),
    blockedReason: r.blocked_reason ? String(r.blocked_reason) : null,
    error: r.error ? String(r.error) : null,
    assetIds,
    isTest: Number(r.is_test ?? 0) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

const JOB_SELECT = `
  SELECT job.*, workflow.name AS workflow_name
  FROM job JOIN workflow ON workflow.id = job.workflow_id`

export function createJob(
  workflowId: string,
  inputs: Record<string, string>,
  stepCount: number,
  isTest = false,
): Job {
  // A run belongs to its workflow's project, not to whatever is active now: a
  // job in flight must not change project because somebody switched the
  // dashboard while it was running.
  const owningProject = getWorkflow(workflowId)?.projectId ?? activeProject().id
  const db = open()
  const id = randomUUID()
  const at = nowIso()
  db.prepare(
    `INSERT INTO job (id, project_id, workflow_id, inputs, status, step_index, step_count, is_test, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
  ).run(id, owningProject, workflowId, JSON.stringify(inputs), stepCount, isTest ? 1 : 0, at, at)
  return getJob(id)!
}

export function getJob(id: string): Job | null {
  const r = open().prepare(`${JOB_SELECT} WHERE job.id = ?`).get(id)
  if (!r) return null
  return rowToJob(r as Record<string, unknown>, assetIdsForJob(id))
}

export function listJobs(statuses?: JobStatus[], limit = 50, projectId = activeProject().id): Job[] {
  const db = open()
  const rows = statuses?.length
    ? db
        .prepare(
          `${JOB_SELECT} WHERE job.project_id = ? AND job.status IN (${statuses.map(() => '?').join(',')})
           ORDER BY job.created_at DESC LIMIT ?`,
        )
        .all(projectId, ...statuses, limit)
    : db
        .prepare(`${JOB_SELECT} WHERE job.project_id = ? ORDER BY job.created_at DESC LIMIT ?`)
        .all(projectId, limit)
  return (rows as Record<string, unknown>[]).map((r) => rowToJob(r, assetIdsForJob(String(r.id))))
}

export function updateJob(
  id: string,
  patch: Partial<Pick<Job, 'status' | 'stepIndex' | 'blockedReason' | 'error'>>,
): void {
  const db = open()
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.status !== undefined) (sets.push('status = ?'), vals.push(patch.status))
  if (patch.stepIndex !== undefined) (sets.push('step_index = ?'), vals.push(patch.stepIndex))
  if (patch.blockedReason !== undefined)
    (sets.push('blocked_reason = ?'), vals.push(nz(patch.blockedReason)))
  if (patch.error !== undefined) (sets.push('error = ?'), vals.push(nz(patch.error)))
  if (!sets.length) return
  sets.push('updated_at = ?')
  vals.push(nowIso(), id)
  db.prepare(`UPDATE job SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]))
}

export function addJobEvent(jobId: string, kind: string, detail: unknown = {}): void {
  open()
    .prepare(`INSERT INTO job_event (job_id, at, kind, detail) VALUES (?, ?, ?, ?)`)
    .run(jobId, nowIso(), kind, JSON.stringify(detail))
}

export function jobEvents(jobId: string, limit = 200) {
  return open()
    .prepare(`SELECT at, kind, detail FROM job_event WHERE job_id = ? ORDER BY id LIMIT ?`)
    .all(jobId, limit) as { at: string; kind: string; detail: string }[]
}

/* ------------------------------------------------------------------ assets */

function assetIdsForJob(jobId: string): string[] {
  const rows = open()
    .prepare(`SELECT id FROM asset WHERE job_id = ? ORDER BY created_at`)
    .all(jobId) as { id: string }[]
  return rows.map((r) => r.id)
}

function rowToAsset(r: Record<string, unknown>): Asset {
  return {
    id: String(r.id),
    sha256: String(r.sha256),
    mime: String(r.mime),
    bytes: Number(r.bytes),
    width: r.width == null ? null : Number(r.width),
    height: r.height == null ? null : Number(r.height),
    jobId: r.job_id ? String(r.job_id) : null,
    workflowName: r.workflow_name ? String(r.workflow_name) : null,
    prompt: r.prompt ? String(r.prompt) : null,
    description: r.description ? String(r.description) : null,
    tags: j<string[]>(r.tags, []),
    createdAt: String(r.created_at),
  }
}

export function createAsset(a: Omit<Asset, 'id' | 'createdAt'>): Asset {
  const id = randomUUID()
  open()
    .prepare(
      `INSERT INTO asset (id, project_id, sha256, mime, bytes, width, height, job_id, workflow_name, prompt, description, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      // An asset produced by a run belongs where the run does; one stored
      // directly belongs wherever we are standing.
      (a.jobId ? getJob(a.jobId)?.projectId : null) ?? activeProject().id,
      a.sha256,
      a.mime,
      a.bytes,
      nz(a.width),
      nz(a.height),
      nz(a.jobId),
      nz(a.workflowName),
      nz(a.prompt),
      nz(a.description),
      JSON.stringify(a.tags),
      nowIso(),
    )
  return getAsset(id)!
}

export function getAsset(id: string): Asset | null {
  const r = open().prepare(`SELECT * FROM asset WHERE id = ?`).get(id)
  return r ? rowToAsset(r as Record<string, unknown>) : null
}

export function listAssets(limit = 50, tag?: string, projectId = activeProject().id): Asset[] {
  const db = open()
  const rows = tag
    ? db
        .prepare(
          `SELECT * FROM asset WHERE project_id = ? AND tags LIKE ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(projectId, `%"${tag}"%`, limit)
    : db
        .prepare(`SELECT * FROM asset WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(projectId, limit)
  return (rows as Record<string, unknown>[]).map(rowToAsset)
}

/* ------------------------------------------------------------------ drafts */

export function createDraft(d: {
  name: string
  profileId: string | null
  origins: string[]
  raw: unknown
}): string {
  const id = randomUUID()
  open()
    .prepare(
      `INSERT INTO draft (id, project_id, name, profile_id, origins, raw, reviewed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(id, activeProject().id, d.name, nz(d.profileId), JSON.stringify(d.origins ?? []), JSON.stringify(d.raw), nowIso())
  return id
}

export function listDrafts(unreviewedOnly = true, projectId = activeProject().id) {
  const sql = unreviewedOnly
    ? `SELECT id, name, origins, created_at FROM draft WHERE project_id = ? AND reviewed = 0 ORDER BY created_at DESC`
    : `SELECT id, name, origins, created_at FROM draft WHERE project_id = ? ORDER BY created_at DESC`
  return open().prepare(sql).all(projectId) as {
    id: string
    name: string
    origins: string
    created_at: string
  }[]
}

export function getDraft(id: string) {
  const r = open().prepare(`SELECT * FROM draft WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  return {
    id: String(r.id),
    name: String(r.name),
    profileId: r.profile_id ? String(r.profile_id) : null,
    origins: j<string[]>(r.origins, []),
    raw: j<unknown>(r.raw, null),
    reviewed: Number(r.reviewed) === 1,
    createdAt: String(r.created_at),
  }
}

export function markDraftReviewed(id: string): void {
  open().prepare(`UPDATE draft SET reviewed = 1 WHERE id = ?`).run(id)
}

/* ------------------------------------------------------------ step health */

/** Record which selector candidate actually resolved. Called on every step ack,
 *  so it is an upsert rather than a log — the question is "what is it matching
 *  on now", not "what has it ever matched on". */
export function recordStepMatch(
  workflowId: string,
  stepId: string,
  strategy: string,
  score: number,
): void {
  open()
    .prepare(
      `INSERT INTO step_health (workflow_id, step_id, strategy, score, at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, step_id) DO UPDATE SET
         strategy = excluded.strategy,
         score = excluded.score,
         at = excluded.at`,
    )
    .run(workflowId, stepId, strategy, Math.round(score), nowIso())
}

export function stepMatches(workflowId: string): StepMatch[] {
  const rows = open()
    .prepare(`SELECT step_id, strategy, score, at FROM step_health WHERE workflow_id = ?`)
    .all(workflowId) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    stepId: String(r.step_id),
    strategy: String(r.strategy) as StepMatch['strategy'],
    score: Number(r.score),
    at: String(r.at),
  }))
}

/** Forget what a step used to match on. Called when its selectors are replaced,
 *  because a match recorded against the old selectors says nothing about the
 *  new ones. */
export function clearStepMatch(workflowId: string, stepId: string): void {
  open().prepare(`DELETE FROM step_health WHERE workflow_id = ? AND step_id = ?`).run(workflowId, stepId)
}

/* ------------------------------------------------------------ step edits */

/** Replace one step in place, keeping its position and its id. This is the
 *  repair path: a workflow whose page moved needs one step fixed, not a
 *  re-recording of the whole thing. */
export function replaceStep(workflowId: string, stepId: string, next: Partial<Step>): Workflow {
  const wf = getWorkflow(workflowId)
  if (!wf) throw new Error(`no workflow ${workflowId}`)
  const index = wf.steps.findIndex((s) => s.id === stepId)
  if (index === -1) throw new Error(`workflow "${wf.name}" has no step ${stepId}`)
  const merged: Step = { ...wf.steps[index]!, ...next, id: stepId }
  const steps = [...wf.steps]
  steps[index] = merged
  clearStepMatch(workflowId, stepId)
  return saveWorkflow({ ...wf, steps })
}

/**
 * Change one step's value, and nothing else.
 *
 * The one edit a workflow accepts after it is recorded. A step's *action* is
 * what the person demonstrated and is not re-openable — changing "click" to
 * "type" after the fact describes a workflow nobody ever performed. Its value
 * is the opposite: whether the caller supplies it, and what a test run should
 * type, are both things you find out later.
 *
 * Deliberately no selector change here: that is repair_step's job, and it has
 * to clear the step's health where this must not.
 */
export function setStepValue(
  workflowId: string,
  stepId: string,
  next: { valueMode?: Step['valueMode']; sampleValue?: string; inputName?: string },
): Workflow {
  const wf = getWorkflow(workflowId)
  if (!wf) throw new Error(`no workflow ${workflowId}`)
  const index = wf.steps.findIndex((s) => s.id === stepId)
  if (index === -1) throw new Error(`workflow "${wf.name}" has no step ${stepId}`)
  const step = wf.steps[index]!
  if (step.kind !== 'type' && step.kind !== 'select') {
    throw new Error('only a step that types or chooses something carries a value')
  }

  const mode = next.valueMode ?? step.valueMode ?? 'static'
  const sample = next.sampleValue ?? step.sampleValue ?? ''
  const name = inputKey(next.inputName ?? step.inputName ?? inputNameFor(step))

  // Two dynamic fields cannot ask for the same value. Compared on what the name
  // becomes rather than on what was typed: "Same text", "SAME Text" and
  // "same_text" are one name, and an agent handed the workflow would see one
  // input where the person thought they had made two.
  if (mode === 'dynamic') {
    if (!name) throw new Error('give the value a name the agent can pass it under')
    const clash = nameClash(wf.steps, name, stepId)
    if (clash) {
      throw new Error(
        `"${clash.target ?? clash.note ?? 'another step'}" already asks the agent for "${askedName(clash)}". ` +
          'Two fields cannot share a name — the caller passes one value and both would get it. Give this one a different name.',
      )
    }
  }

  const merged: Step = {
    ...step,
    valueMode: mode,
    sampleValue: sample,
    ...(mode === 'dynamic' ? { inputName: name, value: `{{${name}}}` } : { value: sample }),
  }
  // A static step keeps no input name: leaving one behind would put a phantom
  // input in the workflow's signature that nothing ever fills.
  if (mode === 'static') delete merged.inputName

  const steps = [...wf.steps]
  steps[index] = merged
  return saveWorkflow({ ...wf, steps, inputs: inputsFrom(steps) })
}

export function setWorkflowStatus(id: string, status: WorkflowStatus): Workflow {
  const wf = getWorkflow(id)
  if (!wf) throw new Error(`no workflow ${id}`)
  if (status === 'active' && wf.steps.length === 0) {
    throw new Error(`workflow "${wf.name}" has no steps to run`)
  }
  return saveWorkflow({ ...wf, status })
}

/* -------------------------------------------------------------- run history */

export interface RunHistory {
  workflowId: string
  total: number
  ok: number
  failed: number
  lastAt: string | null
  /** Most recent runs, newest last, as statuses. Enough to draw a strip and see
   *  whether the failures are recent or ancient. */
  recent: string[]
}

/**
 * Per-workflow run counts.
 *
 * A dashboard that lists eight identical "done · 2d ago" rows has printed a log
 * and called it a summary. What a person wants from a history is the shape of
 * it: how many, how many worked, when it last ran.
 */
export function runHistory(limitPerWorkflow = 20, projectId = activeProject().id): Map<string, RunHistory> {
  const rows = open()
    .prepare(
      `SELECT workflow_id, status, updated_at
         FROM job
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT 500`,
    )
    .all(projectId) as Array<Record<string, unknown>>

  const out = new Map<string, RunHistory>()
  for (const r of rows) {
    const id = String(r.workflow_id)
    const status = String(r.status)
    let entry = out.get(id)
    if (!entry) {
      entry = { workflowId: id, total: 0, ok: 0, failed: 0, lastAt: null, recent: [] }
      out.set(id, entry)
    }
    entry.total += 1
    if (status === 'done') entry.ok += 1
    else if (status === 'failed' || status === 'cancelled') entry.failed += 1
    if (!entry.lastAt) entry.lastAt = String(r.updated_at)
    if (entry.recent.length < limitPerWorkflow) entry.recent.unshift(status)
  }
  return out
}

/** Describe an asset in words. Returns the updated asset, so a caller does not
 *  have to re-read it to confirm what stuck. */
export function setAssetDescription(id: string, description: string | null): Asset | null {
  open()
    .prepare(`UPDATE asset SET description = ? WHERE id = ?`)
    .run(description && description.trim() ? description.trim() : null, id)
  return getAsset(id)
}

/**
 * Runs per day, oldest first, for the last `days` days — including the days
 * nothing ran, because a gap is information and a chart that silently omits it
 * lies about the shape of the week.
 */
export function runsByDay(days = 14, projectId = activeProject().id): Array<{ day: string; ok: number; failed: number }> {
  const rows = open()
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status IN ('failed','cancelled') THEN 1 ELSE 0 END) AS failed
         FROM job
        WHERE project_id = ?
        GROUP BY day`,
    )
    .all(projectId) as Array<Record<string, unknown>>

  const found = new Map(rows.map((r) => [String(r.day), { ok: Number(r.ok), failed: Number(r.failed) }]))
  const out: Array<{ day: string; ok: number; failed: number }> = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    const hit = found.get(d)
    out.push({ day: d, ok: hit?.ok ?? 0, failed: hit?.failed ?? 0 })
  }
  return out
}

/** How many asset rows point at the same bytes. Storage is content-addressed,
 *  so this is the question that decides whether a blob can go. */
export function assetsWithSha(sha256: string): number {
  const row = open()
    .prepare(`SELECT COUNT(*) AS n FROM asset WHERE sha256 = ?`)
    .get(sha256) as { n: number }
  return Number(row.n)
}

export function deleteAsset(id: string): boolean {
  return open().prepare(`DELETE FROM asset WHERE id = ?`).run(id).changes > 0
}
