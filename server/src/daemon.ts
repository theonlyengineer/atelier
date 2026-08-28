/**
 * The long-lived process. Owns the database, the extension WebSocket, and the
 * control API the MCP processes call.
 *
 * It is separate from the MCP server on purpose: Claude Code spawns one MCP
 * process per session, and if that process owned the WebSocket port then two
 * sessions would fight over it and the extension would flap between them.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { writeFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, PORT_FILE, ensureDirs, LOG_FILE } from './paths.ts'
import { open } from './db/index.ts'
import * as repo from './db/repo.ts'
import * as assets from './core/assets.ts'
import { Hub } from './ws/hub.ts'
import { Runner } from './core/runner.ts'
import { routes, type ApiDeps } from './http/api.ts'
import type { ClientMsg } from './ws/protocol.ts'

export const VERSION = '0.1.0'

const log = (...parts: unknown[]) => {
  const line = `${new Date().toISOString()} ${parts.map(String).join(' ')}\n`
  try {
    appendFileSync(LOG_FILE, line)
  } catch {
    /* logging must never take the daemon down */
  }
  if (process.env.ATELIER_VERBOSE) process.stderr.write(line)
}

function readJson(req: IncomingMessage, limitBytes = 8 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limitBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function readBuffer(req: IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limitBytes) {
        reject(new Error('upload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export async function startDaemon(port = DEFAULT_PORT): Promise<{ port: number; close: () => void }> {
  ensureDirs()
  open()

  const hub = new Hub()
  let deps: ApiDeps

  const pushState = () => {
    hub.broadcast({
      t: 'state',
      jobs: repo.listJobs(['queued', 'running', 'blocked'], 20),
      drafts: repo.listDrafts(true).length,
      workflows: repo
        .listWorkflows('active')
        .map((w) => ({ name: w.name, produces: w.produces })),
    })
  }

  const runner = new Runner({
    hub,
    onChange: pushState,
    notify: (title, body) => log(`NOTIFY ${title}: ${body}`),
  })
  deps = { hub, runner, version: VERSION }

  const server = createServer(async (req, res) => {
    // Loopback only. The daemon binds 127.0.0.1 as well, so this is belt and
    // braces against a proxy in front of it.
    const remote = req.socket.remoteAddress ?? ''
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      return json(res, 403, { error: 'loopback only' })
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

    // The extension is a chrome-extension:// origin, so CORS has to allow it.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,x-atelier-job,x-atelier-mime,x-atelier-prompt',
      })
      return res.end()
    }
    res.setHeader('access-control-allow-origin', '*')

    if (url.pathname === '/health') return json(res, 200, { ok: true, version: VERSION })

    // Artifact upload from the extension: raw body, metadata in headers, so
    // there is no multipart parser to maintain.
    if (url.pathname === '/upload' && req.method === 'POST') {
      try {
        const data = await readBuffer(req)
        const jobId = String(req.headers['x-atelier-job'] ?? '') || null
        const mime = String(req.headers['x-atelier-mime'] ?? 'application/octet-stream')
        const prompt = req.headers['x-atelier-prompt']
          ? Buffer.from(String(req.headers['x-atelier-prompt']), 'base64').toString('utf-8')
          : null
        const job = jobId ? repo.getJob(jobId) : null
        const asset = assets.store(data, {
          mime,
          jobId,
          workflowName: job?.workflowName ?? null,
          prompt: prompt ?? (job ? JSON.stringify(job.inputs) : null),
          tags: job ? [job.workflowName] : [],
        })
        if (jobId) repo.addJobEvent(jobId, 'asset', { assetId: asset.id, bytes: asset.bytes })
        log(`upload ${asset.id} ${asset.mime} ${asset.bytes}b`)
        pushState()
        return json(res, 200, { asset })
      } catch (e) {
        return json(res, 400, { error: (e as Error).message })
      }
    }

    const route = routes[url.pathname]
    if (route && req.method === 'POST') {
      try {
        const body = await readJson(req)
        return json(res, 200, { ok: true, result: route(body, deps) })
      } catch (e) {
        log(`api error ${url.pathname}: ${(e as Error).message}`)
        return json(res, 400, { ok: false, error: (e as Error).message })
      }
    }

    return json(res, 404, { error: 'not found' })
  })

  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', (socket: WebSocket) => {
    let client: ReturnType<Hub['register']> | null = null

    socket.on('message', (raw) => {
      let msg: ClientMsg
      try {
        msg = JSON.parse(String(raw)) as ClientMsg
      } catch {
        return
      }

      if (msg.t === 'hello') {
        client = hub.register(socket, msg)
        log(`extension connected: ${msg.label} (${msg.profileId.slice(0, 8)})`)
        hub.send(client, { t: 'hello.ok', serverVersion: VERSION })
        runner.onClientConnected()
        pushState()
        return
      }
      if (msg.t === 'ping') return
      if (!client) return // everything else requires a hello first
      hub.dispatch(msg, client)
    })

    socket.on('close', () => {
      hub.drop(socket)
      log('extension disconnected')
      pushState()
    })
    socket.on('error', () => hub.drop(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  writeFileSync(PORT_FILE, String(port))
  log(`atelierd ${VERSION} listening on 127.0.0.1:${port}`)

  return {
    port,
    close: () => {
      wss.close()
      server.close()
    },
  }
}

// Entry point when run directly (dist/daemon.js).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDaemon().catch((e) => {
    log(`fatal: ${e.message}`)
    process.exit(1)
  })
}
