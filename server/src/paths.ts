/**
 * Every path Atelier uses, in one place.
 *
 * State lives under ~/.atelier rather than in the repo: workflows and assets are
 * per-machine (they encode this browser's profiles and this machine's sessions),
 * and the repo is shared. ATELIER_HOME overrides the lot, which is what the
 * tests use.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export const HOME = process.env.ATELIER_HOME || join(homedir(), '.atelier')

export const DB_PATH = join(HOME, 'atelier.db')
export const ASSETS_DIR = join(HOME, 'assets')
export const RUN_DIR = join(HOME, 'run')
export const IPC_SOCKET = join(RUN_DIR, 'atelierd.sock')
export const PORT_FILE = join(RUN_DIR, 'port')
export const LOG_FILE = join(HOME, 'atelierd.log')

/** Default HTTP/WS port. Overridable because 7717 could be taken. */
export const DEFAULT_PORT = Number(process.env.ATELIER_PORT || 7717)

export function ensureDirs(): void {
  for (const dir of [HOME, ASSETS_DIR, RUN_DIR]) {
    mkdirSync(dir, { recursive: true })
  }
}

/** Content-addressed blob path: assets/ab/abcdef... — two-level fanout. */
export function blobPath(sha256: string): string {
  return join(ASSETS_DIR, sha256.slice(0, 2), sha256)
}
