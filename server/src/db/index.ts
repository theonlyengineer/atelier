/**
 * SQLite access. Uses node:sqlite (Node 22+), so there is no native module to
 * build and nothing to install — which matters for a tool meant to be cloned
 * and run rather than deployed.
 */
import { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DB_PATH, ensureDirs } from '../paths.ts'

const SCHEMA_VERSION = 4

/**
 * A project's bearer token.
 *
 * Long enough that guessing is not a strategy, short enough to paste, and
 * generated here rather than asked for — the whole point of the thing is that
 * connecting an agent to a project is a copy, not a decision.
 */
export const newToken = (): string => randomBytes(24).toString('base64url')

let db: DatabaseSync | null = null

export function open(path = DB_PATH): DatabaseSync {
  if (db) return db
  ensureDirs()
  db = new DatabaseSync(path)

  const here = dirname(fileURLToPath(import.meta.url))
  // Resolves in both dist/ (schema copied alongside) and src/ under --experimental-strip-types.
  const schema = readFileSync(join(here, 'schema.sql'), 'utf-8')
  db.exec(schema)

  // The database holds every project's MCP token, so it is the credential file
  // now. Other users on a shared machine are exactly who this mode is for.
  try {
    chmodSync(path, 0o600)
  } catch {
    /* a filesystem that has no modes is not a reason to refuse to start */
  }

  // schema.sql is all CREATE TABLE IF NOT EXISTS, so it brings a fresh database
  // fully up to date. A database that already exists needs the difference
  // applied by hand — this is that list, smallest thing that works.
  migrate(db)

  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined
  if (!row) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    )
  } else if (Number(row.value) < SCHEMA_VERSION) {
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION))
  } else if (Number(row.value) > SCHEMA_VERSION) {
    throw new Error(
      `atelier.db is schema v${row.value}, this build understands v${SCHEMA_VERSION}. Upgrade the server.`,
    )
  }

  return db
}

/**
 * Columns added after v1. Checked against the table rather than the recorded
 * version, so it is safe to run every open and safe on a database whose version
 * row is wrong — which is the failure mode a hand-written migration usually has.
 */
function migrate(db: DatabaseSync): void {
  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)

  if (!columns('asset').includes('description')) {
    db.exec(`ALTER TABLE asset ADD COLUMN description TEXT`)
  }

  /* ---- v3: everything belongs to a project ---------------------------- */

  // schema.sql already created the project table. A database that predates it
  // has rows with nowhere to live, so they all move into one Default project —
  // which is also what a fresh install gets, so both paths converge.
  if (!columns('project').includes('token')) {
    db.exec(`ALTER TABLE project ADD COLUMN token TEXT NOT NULL DEFAULT ''`)
  }
  if (!columns('job').includes('is_test')) {
    db.exec(`ALTER TABLE job ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0`)
  }

  const projects = db.prepare(`SELECT COUNT(*) AS n FROM project`).get() as { n: number }
  let defaultId: string | null = null
  if (projects.n === 0) {
    defaultId = randomUUID()
    db.prepare(
      `INSERT INTO project (id, name, slug, token, created_at) VALUES (?, 'Default', 'default', ?, ?)`,
    ).run(defaultId, newToken(), new Date().toISOString())
  } else {
    const first = db.prepare(`SELECT id FROM project ORDER BY created_at LIMIT 1`).get() as { id: string }
    defaultId = first.id
  }

  for (const table of ['job', 'asset', 'draft']) {
    if (!columns(table).includes('project_id')) {
      // No NOT NULL on the added column: SQLite cannot add a NOT NULL column
      // without a default, and a constant default here would be a lie the day
      // somebody deletes that project. The backfill immediately after is what
      // makes it non-null in practice.
      db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT REFERENCES project(id)`)
    }
    db.prepare(`UPDATE ${table} SET project_id = ? WHERE project_id IS NULL`).run(defaultId)
  }

  // workflow needs a rebuild rather than an ALTER: its UNIQUE moves from (name)
  // to (project_id, name), and SQLite cannot alter a constraint in place. Ids
  // are preserved, so every foreign key pointing at a workflow stays valid.
  if (!columns('workflow').includes('project_id')) {
    db.exec(`PRAGMA foreign_keys = OFF`)
    db.exec(`
      BEGIN;
      CREATE TABLE workflow_v3 (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES project(id),
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'draft',
        origins     TEXT NOT NULL DEFAULT '[]',
        profile_id  TEXT REFERENCES profile(id),
        inputs      TEXT NOT NULL DEFAULT '[]',
        steps       TEXT NOT NULL DEFAULT '[]',
        produces    TEXT NOT NULL DEFAULT 'none',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        UNIQUE (project_id, name)
      );
      INSERT INTO workflow_v3
        SELECT id, '${defaultId}', name, description, status, origins, profile_id,
               inputs, steps, produces, created_at, updated_at
          FROM workflow;
      DROP TABLE workflow;
      ALTER TABLE workflow_v3 RENAME TO workflow;
      COMMIT;
    `)
    db.exec(`PRAGMA foreign_keys = ON`)
    db.exec(`CREATE INDEX IF NOT EXISTS workflow_project_idx ON workflow(project_id)`)
  }

  // A project that predates per-project tokens has an empty one. Filled before
  // the unique index below, which an empty string in two rows would fail.
  for (const row of db.prepare(`SELECT id FROM project WHERE token = ''`).all() as Array<{
    id: string
  }>) {
    db.prepare(`UPDATE project SET token = ? WHERE id = ?`).run(newToken(), row.id)
  }

  backfillStepValues(db)

  // Indexes last, once every column they name is guaranteed to exist.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS project_token_idx ON project(token);
    CREATE INDEX IF NOT EXISTS workflow_project_idx ON workflow(project_id);
    CREATE INDEX IF NOT EXISTS job_project_idx ON job(project_id);
    CREATE INDEX IF NOT EXISTS asset_project_idx ON asset(project_id);
    CREATE INDEX IF NOT EXISTS draft_project_idx ON draft(project_id);
  `)

  // Whatever happens, there is an active project. A daemon with none would have
  // no answer to "where does this go", which is not a state worth supporting.
  const active = db.prepare(`SELECT value FROM meta WHERE key = 'active_project'`).get() as
    | { value: string }
    | undefined
  const stillExists =
    active && db.prepare(`SELECT 1 FROM project WHERE id = ?`).get(active.value)
  if (!stillExists) {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('active_project', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(defaultId)
  }
}

/**
 * Teach a workflow recorded by the old recorder to say what it already meant.
 *
 * A step used to carry a value and nothing else; whether the caller supplied it
 * was expressed only by the value happening to be a {{placeholder}}, and a
 * workflow's inputs were a separate list written once at proposal time.
 *
 * Both are now derived from the steps, which is what keeps a signature from
 * drifting from what the steps actually do. Without this backfill the first
 * edit to any value on an old workflow would rebuild its inputs from steps that
 * never said they were dynamic — and quietly drop every input it declared,
 * breaking the workflow for the agent that has been calling it for weeks.
 *
 * `sampleValue` on a migrated dynamic step is empty, because the text that was
 * typed was never stored. That is honest: the workflow's page says a test run
 * would type nothing, which is an invitation to fill it in rather than a lie.
 */
function backfillStepValues(db: DatabaseSync): void {
  const rows = db.prepare(`SELECT id, steps FROM workflow`).all() as Array<{
    id: string
    steps: string
  }>

  for (const row of rows) {
    let steps: Array<Record<string, unknown>>
    try {
      steps = JSON.parse(row.steps)
    } catch {
      continue
    }
    if (!Array.isArray(steps)) continue

    let touched = false
    for (const step of steps) {
      if (step.kind !== 'type' && step.kind !== 'select') continue
      if (step.valueMode) continue
      const value = typeof step.value === 'string' ? step.value : ''
      const placeholder = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(value)
      if (placeholder) {
        step.valueMode = 'dynamic'
        step.inputName = placeholder[1]
        step.sampleValue = ''
      } else {
        step.valueMode = 'static'
        step.sampleValue = value
      }
      touched = true
    }
    if (touched) {
      db.prepare(`UPDATE workflow SET steps = ? WHERE id = ?`).run(JSON.stringify(steps), row.id)
    }
  }
}

export function close(): void {
  db?.close()
  db = null
}

export function nowIso(): string {
  return new Date().toISOString()
}
