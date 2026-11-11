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
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ATELIER_HOME = mkdtempSync(join(tmpdir(), 'atelier-mcp-'))
const PORT = 7801
const URL = `http://127.0.0.1:${PORT}/mcp`

const { startDaemon } = await import('../src/daemon.ts')
const repo = await import('../src/db/repo.ts')

let stop: () => void
/** The token a project was born with. It is the credential *and* the scope —
 *  presenting it is what says which project this agent is working in. */
let token: string
let projectId: string

before(async () => {
  stop = (await startDaemon(PORT)).close
  const project = repo.activeProject()
  projectId = project.id
  token = project.token
  HEADERS.authorization = `Bearer ${token}`
})
after(() => stop?.())

const rpc = (id: number, method: string, params: unknown = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params })

const HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  // Both are required by the spec's content negotiation: a Streamable HTTP
  // server may answer a POST with either a JSON body or an SSE stream.
  accept: 'application/json, text/event-stream',
  authorization: '',
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

test('a token from another project is still a token, and still opens only that project', async () => {
  const other = repo.createProject('Elsewhere')
  const res = await fetch(URL, {
    method: 'POST',
    headers: { ...HEADERS, authorization: `Bearer ${other.token}` },
    body: rpc(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    }),
  })
  assert.equal(res.ok, true)
  const sessionId = res.headers.get('mcp-session-id')!
  await res.text()
  const status = await fetch(URL, {
    method: 'POST',
    headers: { ...HEADERS, authorization: `Bearer ${other.token}`, 'mcp-session-id': sessionId },
    body: rpc(2, 'tools/call', { name: 'atelier_status', arguments: {} }),
  })
  const payload = await readResult(status)
  // The whole point of a per-project token: the session knows where it is
  // working from its first call, and was never asked.
  assert.match(payload.result.content[0].text, /Working in project "elsewhere"/)
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
  for (const expected of ['atelier_status', 'run_workflow', 'list_workflows', 'save_asset', 'read_asset_chunk', 'use_project']) {
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
  assert.equal(config.mcpServers.atelier.headers.Authorization, `Bearer ${token}`)
})

test('the config names a project, so one daemon hands out a different file per project', async () => {
  const other = repo.createProject('Second')
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp.json?project=${other.slug}`)
  const config = (await res.json()) as any
  assert.equal(config.mcpServers.atelier.headers.Authorization, `Bearer ${other.token}`)
  assert.notEqual(other.token, token)
})

test('an unknown project is a 404 rather than a config for whichever one is active', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp.json?project=nothing-like-this`)
  assert.equal(res.status, 404)
  await res.text()
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


test('portable asset reads carry bytes and reject another project through the real MCP token gate', async () => {
  const assets = await import('../src/core/assets.ts')
  const asset = repo.withProject(projectId, () => assets.store(Buffer.from('portable fixture'), {mime:'image/png',prompt:'audit prompt'}))
  const other = repo.createProject('Chunk outsider')
  const foreign = repo.withProject(other.id, () => assets.store(Buffer.from('secret fixture'), {mime:'image/png'}))
  const sessionId = await initialize()
  const call = async (id: string) => readResult(await fetch(URL, {
    method:'POST',headers:{...HEADERS,'mcp-session-id':sessionId},
    body:rpc(20,'tools/call',{name:'read_asset_chunk',arguments:{id,offset:0,length:65536}}),
  }))
  const own = await call(asset.id)
  const value = JSON.parse(own.result.content[0].text)
  assert.equal(Buffer.from(value.content,'base64').toString(),'portable fixture')
  assert.equal(value.asset.prompt,'audit prompt')
  assert.equal(value.sha256,asset.sha256)
  const denied = await call(foreign.id)
  assert.equal(denied.result.isError,true)
  assert.match(denied.result.content[0].text,/no asset/)
})


test('daemon-host save retains project-token isolation for both allowed and denied copies', async () => {
 const assets=await import('../src/core/assets.ts')
 const own=repo.withProject(projectId,()=>assets.store(Buffer.from('own copied bytes'),{mime:'image/png'}))
 const other=repo.createProject('Copy outsider')
 const foreign=repo.withProject(other.id,()=>assets.store(Buffer.from('foreign bytes'),{mime:'image/png'}))
 const sessionId=await initialize(),destination=join(process.env.ATELIER_HOME!,'own-copy.png'),denied=join(process.env.ATELIER_HOME!,'foreign-copy.png')
 const save=async(id:string,path:string)=>readResult(await fetch(URL,{method:'POST',headers:{...HEADERS,'mcp-session-id':sessionId},body:rpc(21,'tools/call',{name:'save_asset',arguments:{id,path}})}))
 const positive=await save(own.id,destination);assert.notEqual(positive.result.isError,true);assert.equal(readFileSync(destination).toString(),'own copied bytes')
 const negative=await save(foreign.id,denied);assert.equal(negative.result.isError,true);assert.match(negative.result.content[0].text,/no asset/);assert.equal(existsSync(denied),false)
})
