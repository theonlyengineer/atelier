/**
 * The service worker: one WebSocket to the daemon, and the bridge between the
 * daemon's commands and whatever tab has to carry them out.
 *
 * MV3 terminates service workers aggressively. Rather than fight that, the
 * connection is treated as disposable — an alarm wakes us, we reconnect, and the
 * daemon re-sends the current step for any running job. Nothing is kept in
 * memory that cannot be rebuilt from a reconnect.
 */
import { CANDIDATE_PORTS, MSG } from './protocol.js'

/** Breadcrumbs. An MV3 worker with a silent console is indistinguishable from a
 *  dead one, which is exactly the confusion this cost an afternoon. */
const log = (...a) => console.log('[atelier]', ...a)

let socket = null
let port = null
/** Latest daemon state, mirrored so the side panel opens instantly. */
let state = { jobs: [], drafts: 0, workflows: [] }
/** { draftName, tabId, actions[], origins:Set } while recording. */
let recording = null

/* ------------------------------------------------------------- identity */

async function identity() {
  const stored = await chrome.storage.local.get(['profileId', 'label'])
  let { profileId, label } = stored
  if (!profileId) {
    profileId = crypto.randomUUID()
    // A label the human recognises in the daemon log and in "waiting for X"
    // messages. Chrome's signed-in email is the best automatic guess; the point
    // is that nobody has to type it.
    let email = ''
    try {
      const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })
      email = info?.email || ''
    } catch {
      /* identity.email not granted, or no signed-in profile */
    }
    label = email || 'this browser'
    await chrome.storage.local.set({ profileId, label })
  }
  return { profileId, label }
}

/* ----------------------------------------------------------- connection */

async function probePort() {
  for (const candidate of CANDIDATE_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${candidate}/health`, {
        signal: AbortSignal.timeout(400),
      })
      if (res.ok) return candidate
    } catch {
      /* not this one */
    }
  }
  return null
}

async function connect() {
  if (socket && socket.readyState <= WebSocket.OPEN) {
    // Already connected or connecting; nothing to do, and `port` is whatever
    // found this socket. Do not re-probe — that is what used to null it out.
    return
  }

  port = await probePort()
  if (!port) {
    setBadge('', '')
    return
  }

  const { profileId, label } = await identity()
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)

  socket.addEventListener('open', () => {
    log('connected to daemon on', port)
    send({ t: MSG.HELLO, profileId, label, browser: 'chrome' })
    // Tell any open panel immediately, rather than making it wait for the
    // daemon's next state change — which, on an idle system, never comes.
    chrome.runtime.sendMessage({ t: 'panel.connection', connected: true }).catch(() => {})
  })

  socket.addEventListener('message', (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    handle(msg)
  })

  const mine = socket
  socket.addEventListener('close', (e) => {
    // Only clear the reference if this is still the current socket: a slow close
    // on a replaced connection would otherwise wipe the live one.
    if (socket === mine) {
      socket = null
      setBadge('', '')
      chrome.runtime.sendMessage({ t: 'panel.connection', connected: false }).catch(() => {})
    }
    log('socket closed', e.code || '')
  })
  socket.addEventListener('error', () => {
    try {
      socket?.close()
    } catch {
      /* already closing */
    }
  })
}

function send(msg) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
}

/**
 * Whether we are actually talking to the daemon *right now*.
 *
 * Derived from the socket rather than from `port`, which only records that an
 * HTTP probe once succeeded — a single failed probe used to leave `port` null
 * while the socket was still open, and the panel would report "not connected"
 * about a working connection.
 */
function isConnected() {
  return socket?.readyState === WebSocket.OPEN
}

/* -------------------------------------------------------------- badging */

/**
 * The badge is the whole ambient UI. Red count = jobs that need a human; a dot =
 * work in progress. Nothing else earns pixels on the toolbar.
 */
function setBadge(text, color) {
  chrome.action.setBadgeText({ text })
  if (color) chrome.action.setBadgeBackgroundColor({ color })
}

function reflect(next) {
  state = next
  const blocked = state.jobs.filter((j) => j.status === 'blocked')
  const running = state.jobs.filter((j) => j.status === 'running' || j.status === 'queued')
  if (blocked.length) setBadge(String(blocked.length), '#c0392b')
  else if (running.length) setBadge('•', '#2d7d46')
  else setBadge('', '')
  chrome.runtime.sendMessage({ t: 'panel.state', state }).catch(() => {})
}

/* --------------------------------------------------------- notifications */

const notified = new Set()

function notifyBlocked(job) {
  if (notified.has(job.id)) return
  notified.add(job.id)
  chrome.notifications.create(`atelier:${job.id}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('src/icons/icon128.png'),
    title: `${job.workflowName} needs you`,
    message: job.blockedReason || 'Paused.',
    priority: 2,
    requireInteraction: true,
  })
}

chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith('atelier:')) return
  chrome.notifications.clear(id)
  chrome.windows.getCurrent().then((w) => chrome.sidePanel.open({ windowId: w.id }))
})

/* ------------------------------------------------------ daemon messages */

async function handle(msg) {
  switch (msg.t) {
    case MSG.STATE: {
      reflect(msg)
      for (const job of msg.jobs) {
        if (job.status === 'blocked') notifyBlocked(job)
        else notified.delete(job.id)
      }
      break
    }
    case MSG.JOB_STEP:
      await runStep(msg)
      break
    case MSG.JOB_DONE:
    case MSG.JOB_CANCELLED:
      notified.delete(msg.jobId)
      break
    default:
      break
  }
}

/* ------------------------------------------------------------- replaying */

/** Find or create a tab whose origin the workflow is allowed to touch. */
async function targetTab(origins) {
  const allowed = (url) => {
    try {
      return origins.includes(new URL(url).origin)
    } catch {
      return false
    }
  }
  const tabs = await chrome.tabs.query({})
  const match = tabs.find((t) => t.url && allowed(t.url))
  if (match) return match
  const created = await chrome.tabs.create({ url: origins[0], active: false })
  await waitForLoad(created.id)
  return created
}

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error('the page did not finish loading'))
    }, timeoutMs)
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

async function runStep({ jobId, stepIndex, step, origins, workflowName }) {
  try {
    const tab = await targetTab(origins)

    if (step.kind === 'navigate') {
      await chrome.tabs.update(tab.id, { url: step.value })
      await waitForLoad(tab.id, step.timeoutMs)
      send({ t: MSG.STEP_OK, jobId, stepIndex })
      return
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/replay.js'],
    })

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (s) => window.__atelierReplay(s),
      args: [step],
    })

    if (!result?.ok) {
      send({
        t: MSG.STEP_FAIL,
        jobId,
        stepIndex,
        reason: result?.reason || 'the step did not complete',
        recoverable: result?.recoverable !== false,
      })
      return
    }

    // A capture step hands back a URL or text; the bytes go to the daemon over
    // HTTP rather than the socket, because a WebSocket frame is a poor place for
    // a two-megabyte PNG.
    if (step.kind === 'capture' && result.capture) {
      await upload(jobId, workflowName, result.capture)
    }

    send({ t: MSG.STEP_OK, jobId, stepIndex })
  } catch (e) {
    send({
      t: MSG.STEP_FAIL,
      jobId,
      stepIndex,
      reason: e?.message || String(e),
      recoverable: true,
    })
  }
}

async function upload(jobId, workflowName, capture) {
  let blob
  let mime = 'application/octet-stream'

  if (capture.as === 'text') {
    blob = new Blob([capture.value], { type: 'text/plain' })
    mime = 'text/plain'
  } else {
    // Fetched from the service worker so cross-origin image URLs work without
    // tainting a canvas in the page.
    const res = await fetch(capture.value)
    blob = await res.blob()
    mime = blob.type || 'image/png'
  }

  await fetch(`http://127.0.0.1:${port}/upload`, {
    method: 'POST',
    body: blob,
    headers: {
      'x-atelier-job': jobId,
      'x-atelier-mime': mime,
    },
  })
}

/* ------------------------------------------------------------- recording */

async function startRecording(draftName) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('no active tab')
  recording = { draftName, tabId: tab.id, actions: [], origins: new Set() }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['src/content/recorder.js'],
  })
  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/content/overlay.css'] })
  await chrome.tabs.sendMessage(tab.id, { t: 'record.begin', draftName })
  reflect({ ...state })
}

async function stopRecording() {
  if (!recording) return
  const payload = {
    t: MSG.DRAFT_SAVE,
    name: recording.draftName,
    origins: [...recording.origins],
    raw: { actions: recording.actions, recordedAt: new Date().toISOString() },
  }
  try {
    await chrome.tabs.sendMessage(recording.tabId, { t: 'record.end' })
  } catch {
    /* tab may have gone */
  }
  send(payload)
  recording = null
  reflect({ ...state })
}

/* ---------------------------------------------------- runtime messaging */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    let answered = false
    const reply = (payload) => {
      if (answered) return
      answered = true
      try {
        sendResponse(payload)
      } catch {
        /* the caller went away */
      }
    }
    try {
      await route(msg, reply)
    } catch (e) {
      log('handler failed', msg?.t, e)
      reply({ error: String(e?.message || e) })
    }
    // Belt and braces: a message we accepted but did not answer would hang the
    // caller forever, because we returned true.
    reply({ error: `unhandled message ${msg?.t}` })
  })()
  return true
})

async function route(msg, sendResponse) {
  switch (msg.t) {
    case 'panel.hello': {
      try {
        await connect()
      } catch (e) {
        // Never leave the panel awaiting a response it will not get: an
        // unanswered sendMessage looks identical to "daemon is down".
        console.error('[atelier] connect failed', e)
      }
      // The daemon only pushes state on change, so a panel opened during a
      // quiet period would otherwise render the worker's stale cache.
      if (isConnected()) send({ t: MSG.STATE_REQUEST })
      sendResponse({
        state,
        recording: recording ? { name: recording.draftName } : null,
        connected: isConnected(),
        port,
      })
      break
    }
    case 'panel.resume':
      send({ t: MSG.JOB_RESUME, jobId: msg.jobId })
      sendResponse({ ok: true })
      break
    case 'panel.cancel':
      send({ t: MSG.JOB_CANCEL, jobId: msg.jobId })
      sendResponse({ ok: true })
      break
    case 'panel.record.start':
      await startRecording(msg.name)
      sendResponse({ ok: true })
      break
    case 'panel.record.stop':
      await stopRecording()
      sendResponse({ ok: true })
      break
    case 'record.action':
      if (recording) {
        recording.actions.push(msg.action)
        if (msg.action.origin) recording.origins.add(msg.action.origin)
        chrome.runtime.sendMessage({ t: 'panel.recordCount', count: recording.actions.length }).catch(() => {})
      }
      sendResponse({ ok: true })
      break
    case 'record.stopFromPage':
      await stopRecording()
      sendResponse({ ok: true })
      break
    default:
      sendResponse({ ok: false })
  }
}

/* ------------------------------------------------------------ lifecycle */

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  chrome.alarms.create('atelier-keepalive', { periodInMinutes: 0.5 })
  connect()
})
chrome.runtime.onStartup.addListener(connect)
chrome.alarms.onAlarm.addListener(connect)

connect()
