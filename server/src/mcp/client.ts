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

export async function call<T = any>(path: string, body: unknown = {}): Promise<T> {
  const port = await ensureDaemon()
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await res.json()) as { ok?: boolean; result?: T; error?: string }
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error ?? `daemon returned ${res.status}`)
  }
  return payload.result as T
}
