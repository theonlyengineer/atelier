/**
 * The MCP surface, served by the daemon over Streamable HTTP.
 *
 * The alternative — and still the default — is a process Claude Code spawns per
 * session over stdio. That needs the repo on the machine running the agent. This
 * route needs only a URL and a token, which is what makes a config file portable
 * and a containerised daemon usable at all.
 *
 * One transport and one server per MCP session, because an McpServer connects to
 * exactly one transport and because a session's project binding must not be
 * shared. The session id the transport issues is what a session *is* here, in
 * place of "one process, one session" on the stdio path.
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ApiDeps } from '../http/api.ts'
import { directCall } from './direct.ts'
import { createSession, type BoundProject } from './session.ts'
import { buildServer } from './tools.ts'

const SESSION_HEADER = 'mcp-session-id'

type SdkTransport = Parameters<ReturnType<typeof buildServer>['connect']>[0]

export interface McpEndpoint {
  /** `project` is where the presented token says this agent is working. */
  handle(req: IncomingMessage, res: ServerResponse, project: BoundProject): Promise<void>
  openSessions(): number
  closeAll(): Promise<void>
}

export function createMcpEndpoint(
  deps: () => ApiDeps,
  log: (...parts: unknown[]) => void,
): McpEndpoint {
  const transports = new Map<string, StreamableHTTPServerTransport>()

  async function open(project: BoundProject): Promise<StreamableHTTPServerTransport> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport)
        log(`mcp session opened ${id} (${transports.size} open)`)
      },
      onsessionclosed: (id) => {
        transports.delete(id)
        log(`mcp session closed ${id} (${transports.size} open)`)
      },
    })
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId)
    }
    // A session of its own, so two agents working at once cannot end up sharing
    // a project binding — which is the failure projects exist to prevent. It is
    // bound here, from the token, rather than left for the agent to be asked
    // about: the credential already named a project, and asking a question
    // whose answer you are holding is not a safety measure.
    //
    // The cast is this project's `exactOptionalPropertyTypes`, not a doubt about
    // the shape: the SDK declares `onclose?: () => void`, and under that flag an
    // absent property and one that may be undefined are different types. The
    // transport is the SDK's own and satisfies its own interface at runtime.
    const session = createSession(directCall(deps))
    session.bindProject(project)
    await buildServer(session).connect(transport as SdkTransport)
    return transport
  }

  return {
    async handle(req, res, project) {
      const id = req.headers[SESSION_HEADER]
      const existing = typeof id === 'string' ? transports.get(id) : undefined
      // No session id means this should be an initialize call. The transport
      // itself rejects anything else with a 400, so there is no second copy of
      // that rule here to fall out of step with the spec.
      const transport = existing ?? (await open(project))
      await transport.handleRequest(req, res)
    },
    openSessions: () => transports.size,
    async closeAll() {
      for (const transport of transports.values()) await transport.close()
      transports.clear()
    },
  }
}
