/**
 * The daemon's shared secret.
 *
 * "Only local processes can reach the port" was the whole of the pairing while
 * the MCP surface was a process spawned on the same machine. Serving it over
 * HTTP changes that in two ways: a config file handed to an agent has to carry
 * *something*, and inside a container the remote address of every request is a
 * bridge gateway rather than loopback, so the address is no longer evidence of
 * anything.
 *
 * So the token is the boundary for the MCP endpoint. It is generated once,
 * kept beside the port file, and shown on the dashboard — there is nothing to
 * choose and nothing to rotate by hand, in keeping with the rest of the system.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { TOKEN_FILE, ensureDirs } from '../paths.ts'

/** Long enough that guessing is not a strategy; short enough to paste. */
const BYTES = 24

export { TOKEN_FILE }

export function readOrCreateToken(): string {
  // A compose file pinning one is the case this exists for: the container is
  // handed its secret rather than generating one into a volume nobody reads.
  // Blank is treated as unset, because an empty string here would be a password
  // of no characters rather than a decision to have none.
  const pinned = process.env.ATELIER_TOKEN?.trim()
  if (pinned) return pinned

  ensureDirs()
  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, 'utf-8').trim()
    if (existing) return existing
  }

  const token = randomBytes(BYTES).toString('base64url')
  // 0600 from the moment it exists: this is the credential for everything the
  // daemon can do to a browser, and other users on a shared machine are exactly
  // who that mode is for.
  writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 })
  return token
}
