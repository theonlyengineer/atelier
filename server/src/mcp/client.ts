/**
 * Talks to the daemon, starting it if it isn't up.
 *
 * Auto-start matters for the UX Nizar asked for: nothing to launch, nothing to
 * configure. The first MCP tool call in a fresh session brings the daemon up and
 * everything after it is instant.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, PORT_FILE } from '../paths.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function knownPort(): number {
  if (existsSync(PORT_FILE)) {
    const n = Number(readFileSync(PORT_FILE, 'utf-8').trim())
    if (Number.isFinite(n) && n > 0) return n
  }
  return DEFAULT_PORT
}

async function health(port: number, timeoutMs = 700): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

let ensured = false

async function ensureDaemon(): Promise<number> {
  let port = knownPort()
  if (await health(port)) return port
  if (ensured) {
    // Already tried to start it this process; don't spawn a second one.
    throw new Error('the Atelier daemon is not responding — check ~/.atelier/atelierd.log')
  }
  ensured = true

  const here = dirname(fileURLToPath(import.meta.url))
  const daemonPath = join(here, '..', 'daemon.js')
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', daemonPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()

  for (let i = 0; i < 40; i++) {
    await sleep(100)
    port = knownPort()
    if (await health(port)) return port
  }
  throw new Error('could not start the Atelier daemon — check ~/.atelier/atelierd.log')
}

/** Endpoints that must work before a session knows where it is — otherwise
 *  finding out which projects exist would itself require knowing. */
const UNSCOPED = ['/api/projects.', '/api/health', '/api/overview']

export async function call<T = any>(path: string, body: unknown = {}): Promise<T> {
  const port = await ensureDaemon()
  // Anything that touches a project's contents resolves the session's project
  // first, so no tool can act without knowing where it is. requireProject
  // throws NeedsProject when it cannot tell, and the tool wrapper turns that
  // into a question for the human.
  if (!UNSCOPED.some((prefix) => path.startsWith(prefix))) await requireProject()
  // Once a session knows where it is working, every request says so — the
  // daemon's own active project is for the dashboard and the extension.
  const scoped = bound ? { projectId: bound.id, ...(body as object) } : body
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scoped),
  })
  const payload = (await res.json()) as { ok?: boolean; result?: T; error?: string }
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error ?? `daemon returned ${res.status}`)
  }
  return payload.result as T
}

/* ------------------------------------------------------------- project */

export interface BoundProject {
  id: string
  name: string
  slug: string
}

/**
 * The project this session is working in.
 *
 * One MCP process is one Claude Code session, so a module variable is exactly
 * the right lifetime — it lives and dies with the session. Deliberately *not*
 * "whatever the dashboard is pointed at": an agent halfway through twenty
 * minutes of work should not change project because somebody clicked a menu in
 * another window.
 */
let bound: BoundProject | null = null

export const boundProject = (): BoundProject | null => bound
export const bindProject = (p: BoundProject): BoundProject => (bound = p)

/** Thrown when the session has not been told where to work and cannot guess. */
export class NeedsProject extends Error {
  constructor(public readonly choices: BoundProject[]) {
    super('needs a project')
    this.name = 'NeedsProject'
  }
}

/**
 * Resolve where this session is working, or refuse.
 *
 * Pinned by ATELIER_PROJECT if a checkout wants to fix it. Otherwise: bound
 * already, or exactly one project exists and the answer is obvious, or the
 * human has to say — which is a question, not a default. Picking one silently
 * is how a client's assets end up in another client's project.
 */
export async function requireProject(): Promise<BoundProject> {
  if (bound) return bound

  const { projects } = await call<{ projects: BoundProject[] }>('/api/projects.list', {})

  const pinned = process.env.ATELIER_PROJECT?.trim()
  if (pinned) {
    const hit = projects.find((p) => p.slug === pinned || p.id === pinned || p.name === pinned)
    if (hit) return bindProject(hit)
    throw new Error(
      `ATELIER_PROJECT is set to "${pinned}", which is not a project here. Known: ${projects
        .map((p) => p.slug)
        .join(', ')}`,
    )
  }

  if (projects.length === 1) return bindProject(projects[0]!)
  throw new NeedsProject(projects)
}
