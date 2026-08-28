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

const SCHEMA_VERSION = 1

let db: DatabaseSync | null = null

export function open(path = DB_PATH): DatabaseSync {
  if (db) return db
  ensureDirs()
  db = new DatabaseSync(path)

  const here = dirname(fileURLToPath(import.meta.url))
  // Resolves in both dist/ (schema copied alongside) and src/ under --experimental-strip-types.
  const schema = readFileSync(join(here, 'schema.sql'), 'utf-8')
  db.exec(schema)

  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined
  if (!row) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    )
  } else if (Number(row.value) > SCHEMA_VERSION) {
    throw new Error(
      `atelier.db is schema v${row.value}, this build understands v${SCHEMA_VERSION}. Upgrade the server.`,
    )
  }

  return db
}

export function close(): void {
  db?.close()
  db = null
}

export function nowIso(): string {
  return new Date().toISOString()
}
