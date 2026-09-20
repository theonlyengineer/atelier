/**
 * The transport used when the MCP surface is served by the daemon itself.
 *
 * A spawned MCP process reaches the daemon over loopback HTTP. Inside the
 * daemon there is nothing to reach: the same route table the HTTP API dispatches
 * to is right there, so the session calls it directly rather than making the
 * process talk to itself over a socket. One implementation of the API either
 * way — the routes are the contract, and this only changes how they are reached.
 */
import * as repo from '../db/repo.ts'
import { routes, type ApiDeps } from '../http/api.ts'
import type { RawCall } from './session.ts'

export function directCall(deps: () => ApiDeps): RawCall {
  return async (path, body) => {
    const route = routes[path]
    if (!route) throw new Error(`no such endpoint: ${path}`)
    // Same project scoping the HTTP path applies: a caller may name the project
    // it means, and absent that the daemon's active project is the scope.
    return repo.withProject((body as { projectId?: string })?.projectId, () => route(body, deps()))
  }
}
