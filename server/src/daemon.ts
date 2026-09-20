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
import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PORT,
  PORT_FILE,
  ensureDirs,
  LOG_FILE,
  HOME,
  blobPath,
  BIND,
  isLoopback,
  boundBeyondLoopback,
} from './paths.ts'
import { readOrCreateToken } from './core/token.ts'
import { createMcpEndpoint } from './mcp/http.ts'
import { open } from './db/index.ts'
import * as repo from './db/repo.ts'
import { assessWorkflow } from './core/health.ts'
import * as assets from './core/assets.ts'
import { Hub } from './ws/hub.ts'
import { Runner } from './core/runner.ts'
import { mutates, routes, type ApiDeps } from './http/api.ts'
import { dashboardHtml } from './http/dashboard.ts'
import type { ClientMsg } from './ws/protocol.ts'

export const VERSION = '0.1.0'

/**
 * The `.mcp.json` a person downloads from the dashboard and drops beside a
 * project on any machine that can reach this daemon.
 *
 * The URL is written as loopback because that is what the supplied compose file
 * publishes; point it somewhere else by hand if the daemon is somewhere else.
 */
export function mcpConfig(port: number): unknown {
  return {
    mcpServers: {
      atelier: {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: `Bearer ${readOrCreateToken()}` },
      },
    },
  }
}

const log = (...parts: unknown[]) => {
  const line = `${new Date().toISOString()} ${parts.map(String).join(' ')}\n`
  try {
    appendFileSync(LOG_FILE, line)
  } catch {
    /* logging must never take the daemon down */
  }
  if (process.env.ATELIER_VERBOSE) process.stderr.write(line)
}

/** Last N log lines, cheaply. The file is small and rotated by nothing, so a
 *  full read is fine at the sizes this reaches in practice. */
function tailLog(lines: number): string {
  try {
    if (!existsSync(LOG_FILE)) return ''
    return readFileSync(LOG_FILE, 'utf-8').trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
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
  const startedAt = Date.now()

  /** Everything the dashboard renders, in one snapshot. */
  const overview = () => ({
    version: VERSION,
    projects: repo.listProjects().map((p) => ({ ...p, contents: repo.projectContents(p.id) })),
    activeProject: repo.activeProject(),
    port,
    home: HOME,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    browsers: hub.connected().map((c) => ({
      profileId: c.profileId,
      label: c.label,
      browser: c.browser,
    })),
    jobs: repo.listJobs(['queued', 'running', 'blocked'], 20),
    recent: repo.listJobs(['done', 'failed', 'cancelled'], 8),
    workflows: (() => {
      const history = repo.runHistory()
      return repo.listWorkflows().map((w) => {
      const health = assessWorkflow(w, repo.stepMatches(w.id))
      const runs = history.get(w.id) ?? { total: 0, ok: 0, failed: 0, lastAt: null, recent: [] }
      return {
        name: w.name,
        description: w.description,
        status: w.status,
        produces: w.produces,
        origins: w.origins,
        steps: w.steps.length,
        inputs: w.inputs,
        // The panel needs the steps themselves to offer a repair, and the
        // dashboard needs the health to show what is rotting.
        stepList: w.steps.map((step) => ({ id: step.id, kind: step.kind, note: step.note ?? step.kind })),
        health: { state: health.state, summary: health.summary, degraded: health.degraded },
        runs,
      }
    })
    })(),
    /** Recorded, proposed, and waiting for a human to say yes. Surfaced at the
     *  top level so neither the panel nor Claude has to filter for it. */
    pendingActivation: repo
      .listWorkflows('draft')
      .map((w) => w.name),
    /** Still running, but matching on weaker selectors than they were recorded
     *  with. This is the warning that arrives before the breakage. */
    unhealthy: repo
      .listWorkflows()
      .map((w) => ({ name: w.name, ...assessWorkflow(w, repo.stepMatches(w.id)) }))
      .filter((h) => h.state === 'degraded' || h.state === 'fragile')
      .map((h) => ({ name: h.name, state: h.state, summary: h.summary })),
    assets: repo.listAssets(60),
    runsByDay: repo.runsByDay(14),
    // The full list, not just a count: a recording nobody can see is a
    // recording nobody reviews.
    drafts: repo.listDrafts(true).map((d) => ({
      id: d.id,
      name: d.name,
      origins: JSON.parse(d.origins || '[]') as string[],
      createdAt: d.created_at,
      actions: (() => {
        const full = repo.getDraft(d.id)
        return Array.isArray((full?.raw as any)?.actions) ? (full!.raw as any).actions.length : 0
      })(),
    })),
    counts: {
      workflows: repo.listWorkflows('active').length,
      drafts: repo.listDrafts(true).length,
      assets: repo.listAssets(1000).length,
      jobs: repo.listJobs(undefined, 1000).length,
    },
    // The last few lines are almost always what you want when something is
    // wrong, and opening a file is one step too many at that moment.
    log: tailLog(40),
  })

  /** Dashboard connections. Separate from the extension hub: these are
   *  read-only observers and must never be sent commands. */
  const watchers = new Set<ServerResponse>()

  const pushOverview = () => {
    if (!watchers.size) return
    const frame = `data: ${JSON.stringify(overview())}\n\n`
    for (const res of watchers) {
      try {
        res.write(frame)
      } catch {
        watchers.delete(res)
      }
    }
  }

  const pushState = () => {
    pushOverview()
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
  deps = { hub, runner, version: VERSION, overview }

  // `deps` is assigned above but read lazily, because a session opened later
  // must see the same instances the rest of the daemon is using.
  const mcp = createMcpEndpoint(() => deps, log)

  const server = createServer(async (req, res) => {
    // Loopback only, while loopback still means something.
    //
    // It stops meaning anything inside a container, where every request arrives
    // from a bridge gateway however it was published — so the check is skipped
    // exactly when the daemon has been told to bind beyond loopback, and the
    // boundary becomes whatever published the port (the compose file publishes
    // to the host's loopback) plus the token on /mcp. The check is not softened
    // for the ordinary case, which is still the one almost everybody runs.
    const remote = req.socket.remoteAddress ?? ''
    if (!boundBeyondLoopback() && !isLoopback(remote)) {
      return json(res, 403, { error: 'loopback only' })
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

    // The extension is a chrome-extension:// origin, so CORS has to allow it.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        // `authorization` is deliberately absent. Only the extension needs CORS,
        // and it never sends the token — so a page in the browser cannot
        // preflight a token-bearing request at the daemon. Adding it here to
        // "be consistent" would hand every visited site the MCP endpoint.
        'access-control-allow-headers': 'content-type,x-atelier-job,x-atelier-mime,x-atelier-prompt',
      })
      return res.end()
    }
    res.setHeader('access-control-allow-origin', '*')

    if (url.pathname === '/health') return json(res, 200, { ok: true, version: VERSION })

    // The MCP surface, for an agent pointed at a URL rather than given a process
    // to spawn. The token is the boundary here: inside a container the remote
    // address check above is off, and this is the one endpoint that can drive a
    // browser.
    if (url.pathname === '/mcp') {
      const offered = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      if (offered !== readOrCreateToken()) {
        return json(res, 401, { error: 'bad or missing token — see the dashboard for the .mcp.json' })
      }
      return mcp.handle(req, res)
    }

    // The config file the dashboard offers for download. It carries the token,
    // so it is the one response that must not be readable cross-origin: the
    // wildcard set above would otherwise let any page the human visits read the
    // credential and drive their browser through it.
    if (url.pathname === '/mcp.json' && req.method === 'GET') {
      res.removeHeader('access-control-allow-origin')
      const body = JSON.stringify(mcpConfig(port), null, 2) + '\n'
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'content-disposition': 'attachment; filename=".mcp.json"',
        'cache-control': 'no-store',
      })
      return res.end(body)
    }

    if (url.pathname === '/' && req.method === 'GET') {
      const html = dashboardHtml(VERSION)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
      })
      return res.end(html)
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify(overview())}\n\n`)
      watchers.add(res)
      // A comment frame every 25s keeps the connection off any idle timeout and
      // refreshes the uptime reading without a state change.
      const beat = setInterval(() => {
        try {
          res.write(`data: ${JSON.stringify(overview())}\n\n`)
        } catch {
          clearInterval(beat)
        }
      }, 25_000)
      req.on('close', () => {
        clearInterval(beat)
        watchers.delete(res)
      })
      return
    }

    // Blob bytes, so the dashboard can show what was actually captured.
    if (url.pathname.startsWith('/asset/') && req.method === 'GET') {
      const asset = repo.getAsset(url.pathname.slice('/asset/'.length))
      if (!asset) return json(res, 404, { error: 'no such asset' })
      const path = blobPath(asset.sha256)
      if (!existsSync(path)) return json(res, 404, { error: 'blob missing' })
      const bytes = readFileSync(path)
      res.writeHead(200, {
        'content-type': asset.mime,
        'content-length': bytes.byteLength,
        'cache-control': 'public, max-age=31536000, immutable',
      })
      return res.end(bytes)
    }

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
          // Prefer the actual prompt input over a JSON dump of every input:
          // this string is what the dashboard shows and what makes an asset
          // findable months later.
          prompt:
            prompt ??
            (job ? (job.inputs.prompt ?? job.inputs.subject ?? JSON.stringify(job.inputs)) : null),
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
        // A caller may name the project it means — an agent session bound
        // somewhere other than where the dashboard is pointed. Absent that, the
        // daemon's active project is the scope.
        const result = repo.withProject((body as any)?.projectId, () => route(body, deps))
        // Anything that changed state has to reach the dashboard and the side
        // panel now, not on the next heartbeat.
        if (mutates(url.pathname)) pushState()
        return json(res, 200, { ok: true, result })
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
      if (msg.t === 'state.request') {
        pushState()
        return
      }
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
    server.listen(port, BIND, resolve)
  })

  writeFileSync(PORT_FILE, String(port))
  log(`atelierd ${VERSION} listening on ${BIND}:${port}`)
  log(`mcp endpoint at http://127.0.0.1:${port}/mcp — config at /mcp.json`)

  /**
   * A parked job notifies once. If the browser was shut, or the notification
   * was swiped past, nobody hears about it again and the job waits forever —
   * which reads to the human as Atelier having lost their work. Say it again
   * while it is still waiting.
   */
  const escalations = setInterval(() => {
    try {
      runner.escalateStaleBlocks()
    } catch (e) {
      log('escalation sweep failed', e)
    }
  }, 60_000)
  escalations.unref?.()

  return {
    port,
    close: () => {
      clearInterval(escalations)
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
