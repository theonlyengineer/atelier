/**
 * One agent session's view of the daemon.
 *
 * This used to be a module variable in `client.ts`, and the comment explaining
 * why said it all: one MCP process is one Claude Code session, so a module
 * variable is exactly the right lifetime. That stops being true the moment the
 * MCP surface is served over HTTP from the daemon, where one long-lived process
 * answers every session on the machine — a module variable would then mean two
 * sessions silently sharing a project binding, which is the precise failure
 * projects were introduced to prevent.
 *
 * So the binding lives in an object with a session's lifetime, and the caller
 * decides what a session is: the process, for stdio; the MCP session id, for
 * HTTP.
 */

/** How this session reaches the daemon. Over loopback HTTP from a spawned MCP
 *  process, or by direct dispatch when the MCP surface runs inside the daemon —
 *  the tools cannot tell the difference and must not need to. */
export type RawCall = (path: string, body: unknown) => Promise<any>

export interface BoundProject {
  id: string
  name: string
  slug: string
}

/** Thrown when the session has not been told where to work and cannot guess. */
export class NeedsProject extends Error {
  // Assigned in the body, not as a parameter property: the tests run against
  // src/ under `node --experimental-strip-types`, which rejects those.
  readonly choices: BoundProject[]

  constructor(choices: BoundProject[]) {
    super('needs a project')
    this.name = 'NeedsProject'
    this.choices = choices
  }
}

/** Endpoints that must work before a session knows where it is — otherwise
 *  finding out which projects exist would itself require knowing. */
const UNSCOPED = ['/api/projects.', '/api/health', '/api/overview']

export interface Session {
  call<T = any>(path: string, body?: unknown): Promise<T>
  boundProject(): BoundProject | null
  bindProject(p: BoundProject): BoundProject
  requireProject(): Promise<BoundProject>
}

export function createSession(raw: RawCall): Session {
  /**
   * Deliberately *not* "whatever the dashboard is pointed at": an agent halfway
   * through twenty minutes of work should not change project because somebody
   * clicked a menu in another window.
   */
  let bound: BoundProject | null = null

  const session: Session = {
    boundProject: () => bound,
    bindProject: (p) => (bound = p),

    async call<T = any>(path: string, body: unknown = {}): Promise<T> {
      // Anything that touches a project's contents resolves the session's
      // project first, so no tool can act without knowing where it is.
      // requireProject throws NeedsProject when it cannot tell, and the tool
      // wrapper turns that into a question for the human.
      if (!UNSCOPED.some((prefix) => path.startsWith(prefix))) await session.requireProject()
      // Once a session knows where it is working, every request says so — the
      // daemon's own active project is for the dashboard and the extension.
      const scoped = bound ? { projectId: bound.id, ...(body as object) } : body
      return (await raw(path, scoped)) as T
    },

    /**
     * Resolve where this session is working, or refuse.
     *
     * Pinned by ATELIER_PROJECT if a checkout wants to fix it. Otherwise: bound
     * already, or exactly one project exists and the answer is obvious, or the
     * human has to say — which is a question, not a default. Picking one
     * silently is how a client's assets end up in another client's project.
     */
    async requireProject(): Promise<BoundProject> {
      if (bound) return bound

      const { projects } = (await raw('/api/projects.list', {})) as { projects: BoundProject[] }

      const pinned = process.env.ATELIER_PROJECT?.trim()
      if (pinned) {
        const hit = projects.find((p) => p.slug === pinned || p.id === pinned || p.name === pinned)
        if (hit) return session.bindProject(hit)
        throw new Error(
          `ATELIER_PROJECT is set to "${pinned}", which is not a project here. Known: ${projects
            .map((p) => p.slug)
            .join(', ')}`,
        )
      }

      if (projects.length === 1) return session.bindProject(projects[0]!)
      throw new NeedsProject(projects)
    },
  }

  return session
}
