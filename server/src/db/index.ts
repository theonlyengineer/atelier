/**
 * SQLite access. Uses node:sqlite (Node 22+), so there is no native module to
 * build and nothing to install — which matters for a tool meant to be cloned
 * and run rather than deployed.
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DB_PATH, ensureDirs } from '../paths.ts'

const SCHEMA_VERSION = 2

let db: DatabaseSync | null = null

export function open(path = DB_PATH): DatabaseSync {
  if (db) return db
  ensureDirs()
  db = new DatabaseSync(path)

  const here = dirname(fileURLToPath(import.meta.url))
  // Resolves in both dist/ (schema copied alongside) and src/ under --experimental-strip-types.
  const schema = readFileSync(join(here, 'schema.sql'), 'utf-8')
  db.exec(schema)

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
}

export function close(): void {
  db?.close()
  db = null
}

export function nowIso(): string {
  return new Date().toISOString()
}
