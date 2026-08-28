/**
 * Tracks connected extensions, one per browser profile, and routes messages.
 *
 * A profile can only have one live connection; a second one from the same
 * profile replaces the first, because that is what a browser restart looks like
 * and reconnect storms are not worth modelling.
 */
import type { WebSocket } from 'ws'
import type { ClientMsg, ServerMsg } from './protocol.ts'
import * as repo from '../db/repo.ts'

export interface Client {
  socket: WebSocket
  profileId: string
  label: string
  browser: string
  connectedAt: number
}

type Handler = (msg: ClientMsg, client: Client) => void

export class Hub {
  private byProfile = new Map<string, Client>()
  private handlers: Handler[] = []

  onMessage(h: Handler): void {
    this.handlers.push(h)
  }

  register(socket: WebSocket, hello: Extract<ClientMsg, { t: 'hello' }>): Client {
    const existing = this.byProfile.get(hello.profileId)
    if (existing && existing.socket !== socket) {
      try {
        existing.socket.close(4000, 'replaced by a newer connection')
      } catch {
        /* already gone */
      }
    }

    const client: Client = {
      socket,
      profileId: hello.profileId,
      label: hello.label,
      browser: hello.browser,
      connectedAt: Date.now(),
    }
    this.byProfile.set(hello.profileId, client)
    repo.upsertProfile(hello.profileId, hello.label)
    return client
  }

  drop(socket: WebSocket): void {
    for (const [id, c] of this.byProfile) {
      if (c.socket === socket) this.byProfile.delete(id)
    }
  }

  dispatch(msg: ClientMsg, client: Client): void {
    for (const h of this.handlers) h(msg, client)
  }

  /** The connection for a workflow's profile, or any connection if the workflow
   *  never recorded one (hand-written workflows, and the M1 skeleton). */
  clientFor(profileId: string | null): Client | undefined {
    if (profileId) return this.byProfile.get(profileId)
    return this.byProfile.values().next().value
  }

  send(client: Client, msg: ServerMsg): void {
    if (client.socket.readyState === client.socket.OPEN) {
      client.socket.send(JSON.stringify(msg))
    }
  }

  broadcast(msg: ServerMsg): void {
    for (const c of this.byProfile.values()) this.send(c, msg)
  }

  connected(): Client[] {
    return [...this.byProfile.values()]
  }
}
