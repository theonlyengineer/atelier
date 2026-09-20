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

/**
 * The interface the daemon listens on. Loopback, unless something has taken
 * responsibility for who can reach the socket.
 *
 * A container is that something: inside one, loopback means the container, so a
 * daemon bound there is reachable by nothing at all. The supplied compose file
 * sets this to 0.0.0.0 and then publishes the port to the *host's* loopback,
 * which puts the boundary back where it was — at the edge of the machine —
 * rather than removing it.
 */
export const BIND = process.env.ATELIER_BIND || '127.0.0.1'

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1']

export const isLoopback = (address: string): boolean => LOOPBACK.includes(address)

/** True when the daemon has been told to listen beyond loopback, in which case
 *  a request's remote address is no longer evidence of anything. */
export const boundBeyondLoopback = (): boolean => !isLoopback(BIND)

export function ensureDirs(): void {
  for (const dir of [HOME, ASSETS_DIR, RUN_DIR]) {
    mkdirSync(dir, { recursive: true })
  }
}

/** Content-addressed blob path: assets/ab/abcdef... — two-level fanout. */
export function blobPath(sha256: string): string {
  return join(ASSETS_DIR, sha256.slice(0, 2), sha256)
}
