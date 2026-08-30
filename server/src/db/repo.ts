/**
 * Typed data access. Everything that touches SQL lives here so the rest of the
 * server deals in the shapes from types.ts and nothing else.
 */
import { randomUUID } from 'node:crypto'
import { open, nowIso } from './index.ts'
import type { Asset, Job, JobStatus, Step, Workflow, WorkflowStatus } from '../types.ts'
import type { StepMatch } from '../core/health.ts'

/** node:sqlite rejects `undefined`; JSON round-trips turn absent fields into it. */
const nz = <T>(v: T | undefined | null): T | null => (v === undefined ? null : v)

const j = <T>(s: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(s)) as T
  } catch {
    return fallback
  }
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

export function listWorkflows(status?: WorkflowStatus): Workflow[] {
  const db = open()
  const rows = status
    ? db.prepare(`SELECT * FROM workflow WHERE status = ? ORDER BY name`).all(status)
    : db.prepare(`SELECT * FROM workflow ORDER BY name`).all()
  return (rows as Record<string, unknown>[]).map(rowToWorkflow)
}

export function getWorkflowByName(name: string): Workflow | null {
  const r = open().prepare(`SELECT * FROM workflow WHERE name = ?`).get(name)
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
    `INSERT INTO workflow (id, name, description, status, origins, profile_id, inputs, steps, produces, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, description = excluded.description, status = excluded.status,
       origins = excluded.origins, profile_id = excluded.profile_id, inputs = excluded.inputs,
       steps = excluded.steps, produces = excluded.produces, updated_at = excluded.updated_at`,
  ).run(
    id,
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
    workflowId: String(r.workflow_id),
    workflowName: String(r.workflow_name ?? ''),
    inputs: j<Record<string, string>>(r.inputs, {}),
    status: String(r.status) as JobStatus,
    stepIndex: Number(r.step_index),
    stepCount: Number(r.step_count),
    blockedReason: r.blocked_reason ? String(r.blocked_reason) : null,
    error: r.error ? String(r.error) : null,
    assetIds,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }
}

const JOB_SELECT = `
  SELECT job.*, workflow.name AS workflow_name
  FROM job JOIN workflow ON workflow.id = job.workflow_id`

export function createJob(workflowId: string, inputs: Record<string, string>, stepCount: number): Job {
  const db = open()
  const id = randomUUID()
  const at = nowIso()
  db.prepare(
    `INSERT INTO job (id, workflow_id, inputs, status, step_index, step_count, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
  ).run(id, workflowId, JSON.stringify(inputs), stepCount, at, at)
  return getJob(id)!
}

export function getJob(id: string): Job | null {
  const r = open().prepare(`${JOB_SELECT} WHERE job.id = ?`).get(id)
  if (!r) return null
  return rowToJob(r as Record<string, unknown>, assetIdsForJob(id))
}

export function listJobs(statuses?: JobStatus[], limit = 50): Job[] {
  const db = open()
  const rows = statuses?.length
    ? db
        .prepare(
          `${JOB_SELECT} WHERE job.status IN (${statuses.map(() => '?').join(',')})
           ORDER BY job.created_at DESC LIMIT ?`,
        )
        .all(...statuses, limit)
    : db.prepare(`${JOB_SELECT} ORDER BY job.created_at DESC LIMIT ?`).all(limit)
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
      `INSERT INTO asset (id, sha256, mime, bytes, width, height, job_id, workflow_name, prompt, description, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
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

export function listAssets(limit = 50, tag?: string): Asset[] {
  const db = open()
  const rows = tag
    ? db
        .prepare(
          `SELECT * FROM asset WHERE tags LIKE ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(`%"${tag}"%`, limit)
    : db.prepare(`SELECT * FROM asset ORDER BY created_at DESC LIMIT ?`).all(limit)
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
      `INSERT INTO draft (id, name, profile_id, origins, raw, reviewed, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(id, d.name, nz(d.profileId), JSON.stringify(d.origins ?? []), JSON.stringify(d.raw), nowIso())
  return id
}

export function listDrafts(unreviewedOnly = true) {
  const sql = unreviewedOnly
    ? `SELECT id, name, origins, created_at FROM draft WHERE reviewed = 0 ORDER BY created_at DESC`
    : `SELECT id, name, origins, created_at FROM draft ORDER BY created_at DESC`
  return open().prepare(sql).all() as { id: string; name: string; origins: string; created_at: string }[]
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

export function removeStep(workflowId: string, stepId: string): Workflow {
  const wf = getWorkflow(workflowId)
  if (!wf) throw new Error(`no workflow ${workflowId}`)
  const steps = wf.steps.filter((s) => s.id !== stepId)
  if (steps.length === wf.steps.length) throw new Error(`workflow "${wf.name}" has no step ${stepId}`)
  if (steps.length === 0) throw new Error('a workflow needs at least one step')
  clearStepMatch(workflowId, stepId)
  return saveWorkflow({ ...wf, steps })
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
export function runHistory(limitPerWorkflow = 20): Map<string, RunHistory> {
  const rows = open()
    .prepare(
      `SELECT workflow_id, status, updated_at
         FROM job
        ORDER BY created_at DESC
        LIMIT 500`,
    )
    .all() as Array<Record<string, unknown>>

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
export function runsByDay(days = 14): Array<{ day: string; ok: number; failed: number }> {
  const rows = open()
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status IN ('failed','cancelled') THEN 1 ELSE 0 END) AS failed
         FROM job
        GROUP BY day`,
    )
    .all() as Array<Record<string, unknown>>

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
