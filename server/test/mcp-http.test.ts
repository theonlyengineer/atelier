/**
 * The MCP surface over HTTP, against a real daemon.
 *
 * This is the path that makes a `.mcp.json` worth downloading: an agent that
 * has never seen this repo points at a URL and gets the same tools a spawned
 * stdio process would have. Worth an integration test rather than unit tests,
 * because everything that can go wrong here is in the seams — the token gate,
 * the session header, and whether a second session gets a project binding of
 * its own.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ATELIER_HOME = mkdtempSync(join(tmpdir(), 'atelier-mcp-'))
process.env.ATELIER_TOKEN = 'test-token-not-a-real-one'
const PORT = 7801
const URL = `http://127.0.0.1:${PORT}/mcp`

const { startDaemon } = await import('../src/daemon.ts')

let stop: () => void
before(async () => {
  stop = (await startDaemon(PORT)).close
})
after(() => stop?.())

const rpc = (id: number, method: string, params: unknown = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params })

const HEADERS = {
  'content-type': 'application/json',
  // Both are required by the spec's content negotiation: a Streamable HTTP
  // server may answer a POST with either a JSON body or an SSE stream.
  accept: 'application/json, text/event-stream',
  authorization: 'Bearer test-token-not-a-real-one',
}

/** One frame out of a response that may be JSON or an SSE stream. */
async function readResult(res: Response): Promise<any> {
  const body = await res.text()
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const line = body.split('\n').find((l) => l.startsWith('data:'))
    return JSON.parse(line!.slice(5).trim())
  }
  return JSON.parse(body)
}

/** Initialize, and hand back the session id the transport issued. */
async function initialize(): Promise<string> {
  const res = await fetch(URL, {
    method: 'POST',
    headers: HEADERS,
    body: rpc(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    }),
  })
  assert.equal(res.ok, true, `initialize failed: ${res.status}`)
  const id = res.headers.get('mcp-session-id')
  assert.ok(id, 'a stateful transport must issue a session id')
  await res.text()
  return id!
}

test('the MCP endpoint refuses a request with no token', async () => {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { ...HEADERS, authorization: '' },
    body: rpc(1, 'initialize', {}),
  })
  assert.equal(res.status, 401)
})

test('the MCP endpoint refuses a wrong token', async () => {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { ...HEADERS, authorization: 'Bearer nearly-right' },
    body: rpc(1, 'initialize', {}),
  })
  assert.equal(res.status, 401)
})

test('an agent with the token gets the same tools the stdio process offers', async () => {
  const sessionId = await initialize()
  const res = await fetch(URL, {
    method: 'POST',
    headers: { ...HEADERS, 'mcp-session-id': sessionId },
    body: rpc(2, 'tools/list'),
  })
  const payload = await readResult(res)
  const names = payload.result.tools.map((t: { name: string }) => t.name)
  for (const expected of ['atelier_status', 'run_workflow', 'list_workflows', 'save_asset', 'use_project']) {
    assert.ok(names.includes(expected), `expected the ${expected} tool, got ${names.join(', ')}`)
  }
})

test('a tool actually runs, which means the session reached the daemon itself', async () => {
  const sessionId = await initialize()
  const res = await fetch(URL, {
    method: 'POST',
    headers: { ...HEADERS, 'mcp-session-id': sessionId },
    body: rpc(3, 'tools/call', { name: 'atelier_status', arguments: {} }),
  })
  const payload = await readResult(res)
  assert.ok(payload.result, `expected a result, got ${JSON.stringify(payload).slice(0, 200)}`)
  // Naming this daemon's own port proves the session dispatched into the
  // running process rather than reporting something it made up.
  assert.match(payload.result.content[0].text, new RegExp(`Daemon .* on .*:${PORT}`))
})

test('two sessions get their own transports, so a project binding is not shared', async () => {
  const a = await initialize()
  const b = await initialize()
  assert.notEqual(a, b, 'a second initialize must not be handed the first session')
})

test('a made-up session id is rejected rather than quietly opening a new one', async () => {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { ...HEADERS, 'mcp-session-id': 'not-a-session' },
    body: rpc(4, 'tools/list'),
  })
  assert.equal(res.ok, false)
})

/* ------------------------------------------------------- the config file */

test('the dashboard config carries a working url and the token', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp.json`)
  assert.equal(res.ok, true)
  const config = (await res.json()) as any
  assert.equal(config.mcpServers.atelier.type, 'http')
  assert.equal(config.mcpServers.atelier.url, URL)
  assert.equal(config.mcpServers.atelier.headers.Authorization, 'Bearer test-token-not-a-real-one')
})

test('the config is not readable cross-origin, because it is a credential', async () => {
  // Every other response carries `access-control-allow-origin: *` for the
  // extension. On this one that wildcard would let any page the human visits
  // read the token and drive their browser through it.
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp.json`)
  assert.equal(res.headers.get('access-control-allow-origin'), null)
  await res.text()
})

test('the config downloads as a file rather than rendering in the tab', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp.json`)
  assert.match(res.headers.get('content-disposition') ?? '', /\.mcp\.json/)
  await res.text()
})
