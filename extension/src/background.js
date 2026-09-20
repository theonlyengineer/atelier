/**
 * The service worker: one WebSocket to the daemon, and the bridge between the
 * daemon's commands and whatever tab has to carry them out.
 *
 * MV3 terminates service workers aggressively. Rather than fight that, the
 * connection is treated as disposable — an alarm wakes us, we reconnect, and the
 * daemon re-sends the current step for any running job. Nothing is kept in
 * memory that cannot be rebuilt from a reconnect.
 *
 * Recording lives here too, and it is now a *directed* thing: the page asks us
 * to append a step that the person composed, and we append it. We no longer
 * watch them work and infer what they meant.
 */
import { CANDIDATE_PORTS, MSG } from './protocol.js'

/** Breadcrumbs. An MV3 worker with a silent console is indistinguishable from a
 *  dead one, which is exactly the confusion this cost an afternoon. */
const log = (...a) => console.log('[atelier]', ...a)

let socket = null
let port = null
/** Latest daemon state, mirrored so the popup opens instantly. */
let state = { jobs: [], drafts: 0, workflows: [] }
/* Recording state is NOT held here — see getRecording()/setRecording(). A module
   variable does not survive the service worker being terminated mid-recording. */

/* ------------------------------------------------------------- identity */

async function identity() {
  const stored = await chrome.storage.local.get(['profileId', 'label'])
  let { profileId, label } = stored
  if (!profileId) {
    profileId = crypto.randomUUID()
    // Deliberately not the signed-in email. Reading that needs the
    // `identity.email` permission, which is a real privacy ask for a label
    // nobody strictly needs — and an unused-looking permission is the first
    // thing anyone reviewing this extension will question.
    label = `Chrome (${new Date().toISOString().slice(0, 10)})`
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
    flushPendingDrafts()
    // Tell any open popup immediately, rather than making it wait for the
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
 * while the socket was still open, and the popup would report "not connected"
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
  // A popup can only be opened from a user gesture, and a notification click is
  // not one Chrome will accept everywhere — so this is attempted and allowed to
  // fail. The badge is what actually carries a parked job to the person; the
  // notification is the nudge, not the only signal.
  chrome.action.openPopup?.().catch(() => {})
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
    // The daemon enforces the allowlist, but the browser enforces the grant,
    // and the grant is per origin rather than the whole web. A workflow whose
    // site was never approved parks with something the human can act on
    // instead of failing somewhere inside chrome.scripting.
    if (!(await hasOrigins(origins))) {
      send({
        t: MSG.STEP_FAIL,
        jobId,
        stepIndex,
        reason: `Atelier has not been given access to ${origins.join(', ')} — open the Atelier popup and grant it, then resume`,
        recoverable: true,
      })
      return
    }

    const tab = await targetTab(origins)

    if (step.kind === 'navigate') {
      await chrome.tabs.update(tab.id, { url: step.value })
      await waitForLoad(tab.id, step.timeoutMs)
      send({ t: MSG.STEP_OK, jobId, stepIndex })
      return
    }

    const result = await executeInTab(tab.id, step)

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

    send({
      t: MSG.STEP_OK,
      jobId,
      stepIndex,
      // Which selector actually resolved. The daemon compares it against the
      // one this step was recorded with; that difference is the only warning
      // anyone gets before a workflow stops working.
      ...(result.matched
        ? { matched: { strategy: result.matched.strategy, score: result.matched.score } }
        : {}),
    })
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

/**
 * Perform one step in a tab.
 *
 * The control panel performs a step the same way while it is being recorded —
 * it calls the same `window.__atelierReplay` in the same isolated world, from
 * inside the page rather than through here. That is the point: a step that
 * cannot be performed is refused while somebody is still looking at the page,
 * through exactly the code that will do it again next week.
 */
async function executeInTab(tabId, step) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/replay.js'] })
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (s) => window.__atelierReplay(s),
    args: [step],
  })
  return result
}

async function upload(jobId, workflowName, capture) {
  let blob
  let mime = 'application/octet-stream'

  if (capture.as === 'text') {
    blob = new Blob([capture.value], { type: 'text/plain' })
    mime = 'text/plain'
  } else {
    // Fetched here so cross-origin image URLs work without tainting a canvas in
    // the page. A data: URL arrives when the page had a blob: we could not reach
    // from this context — fetch handles both.
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

/* ----------------------------------------------------------- permissions */

/**
 * Atelier never asks for every site up front.
 *
 * The origin allowlist has always been enforced by the daemon, but asking the
 * browser for one origin at the moment the human points at that site is what
 * makes the promise real — a permission prompt is the part a careful person
 * actually reads.
 */
const originPattern = (origin) => {
  try {
    return `${new URL(origin).origin}/*`
  } catch {
    return null
  }
}

async function hasOrigins(origins) {
  const patterns = origins.map(originPattern).filter(Boolean)
  if (!patterns.length) return false
  return chrome.permissions.contains({ origins: patterns })
}

/* -------------------------------------------------------- daemon (HTTP) */

/** Anything that wants a reply the caller can act on goes through the daemon's
 *  control API rather than the socket. */
async function daemon(path, body) {
  if (!port) port = await probePort()
  if (!port) return { error: 'the Atelier daemon is not running' }
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    const payload = await res.json()
    if (!res.ok || payload.ok === false) return { error: payload.error || `daemon returned ${res.status}` }
    return { ok: true, result: payload.result }
  } catch (e) {
    return { error: String(e?.message || e) }
  }
}

/* ------------------------------------------------------------- recording */

/**
 * Recording state lives in chrome.storage.session, not in a module variable.
 *
 * MV3 terminates the service worker after ~30 seconds without events, and a
 * recording session is by definition time spent interacting with the *page* —
 * for image generation, most of it is spent waiting for a render. A module
 * variable is gone by the time you press Save, and every step goes with it,
 * silently. Session storage survives the worker and dies with the browser,
 * which is exactly the lifetime a recording wants.
 */
const REC_KEY = 'atelier:recording'
const PENDING_KEY = 'atelier:pendingDrafts'

async function getRecording() {
  const bag = await chrome.storage.session.get(REC_KEY)
  return bag[REC_KEY] ?? null
}

async function setRecording(rec) {
  if (rec) await chrome.storage.session.set({ [REC_KEY]: rec })
  else await chrome.storage.session.remove(REC_KEY)
  // Every surface reads the same object, so every surface is told when it
  // changes rather than each keeping its own idea of the recording.
  chrome.runtime.sendMessage({ t: 'panel.recording', recording: rec ?? null }).catch(() => {})
  return rec
}

async function injectPanel(tabId, rec) {
  // replay.js first: the panel performs each step through it, so it has to be
  // there before the first Add step.
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/replay.js'] })
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/recorder.js'] })
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content/overlay.css'] })
  await chrome.tabs.sendMessage(tabId, { t: 'record.begin', recording: rec })
}

const originOf = (url) => {
  try {
    const o = new URL(url).origin
    return o.startsWith('http') ? o : null
  } catch {
    return null
  }
}

/**
 * Begin a recording with no name.
 *
 * The name is asked for in the page, not in the popup, because a popup closes
 * the moment it loses focus and the first thing a person does after starting a
 * recording is look at the page. The popup's job is to get out of the way.
 */
async function startRecording() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('no active tab')
  const origin = originOf(tab.url)
  if (!origin) throw new Error('this page cannot be recorded — open the site you want to automate first')
  if (!(await hasOrigins([origin]))) {
    throw new Error(`Atelier needs permission for ${origin} to record here`)
  }

  const rec = await setRecording({
    mode: 'workflow',
    name: '',
    tabId: tab.id,
    origins: [origin],
    startUrl: tab.url,
    steps: [],
  })
  await injectPanel(tab.id, rec)
  log('recording started on', origin)
  reflect({ ...state })
  return { ok: true }
}

/** Point one step of an existing workflow at a new element. The repair path: a
 *  page that moved needs one step re-aimed, not twenty re-recorded. */
async function startRepoint(workflowName, stepId, stepNote) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return { error: 'no active tab' }
  const origin = originOf(tab.url)
  if (!origin) return { error: "open the workflow's site in this tab first" }
  if (!(await hasOrigins([origin]))) return { error: `Atelier needs permission for ${origin}` }

  const rec = await setRecording({
    mode: 'repoint',
    name: workflowName,
    tabId: tab.id,
    origins: [origin],
    steps: [],
    workflowName,
    stepId,
    stepNote: stepNote ?? '',
  })
  await injectPanel(tab.id, rec)
  reflect({ ...state })
  return { ok: true }
}

async function finishRepoint(pick) {
  const rec = await getRecording()
  if (!rec || rec.mode !== 'repoint') return { error: 'no repoint in progress' }
  await setRecording(null)
  reflect({ ...state })
  send({ t: MSG.STEP_REPOINT, workflowName: rec.workflowName, stepId: rec.stepId, pick })
  log('repointed step', rec.stepId, 'of', rec.workflowName)
  return { ok: true }
}

async function setName(name) {
  const rec = await getRecording()
  if (!rec) return { error: 'no recording in progress' }
  const clean = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (!clean) return { error: 'a workflow needs a name — short and kebab-case' }
  rec.name = clean
  await setRecording(rec)
  return { ok: true, name: clean }
}

/**
 * What a name becomes once it is written down.
 *
 * Mirrored from server/src/core/inputs.ts, the way the wire protocol is — the
 * extension has no build step and cannot import it. The rule is what makes two
 * names the same name: "Same text", "SAME Text" and "same_text" all serialise
 * to `same_text`, and a workflow with both would hand an agent one input where
 * the person thought they had made two.
 */
const inputKey = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)

/** The name a step actually asks for, whichever way it was given one. */
const askedName = (step) => inputKey(step.inputName) || inputKey(step.target)

/**
 * A step already asking for this name, if there is one.
 *
 * Refused rather than repaired: the caller passes one value per name, so two
 * fields sharing one would both receive it — silently not what anybody drawing
 * two boxes meant. The person is right there, and renaming is free.
 */
function nameClash(steps, name, exceptIndex = -1) {
  const key = inputKey(name)
  if (!key) return -1
  return steps.findIndex(
    (step, i) => i !== exceptIndex && step.valueMode === 'dynamic' && askedName(step) === key,
  )
}

const clashMessage = (steps, at) =>
  `Step ${at + 1}, "${steps[at].target || 'another field'}", already asks the agent for ` +
  `"${askedName(steps[at])}". Two fields cannot share a name — the caller passes one value ` +
  'and both would get it. Give this one a different name.'

/**
 * Append a step the person composed.
 *
 * Nothing is inferred and nothing is merged. They pointed at an element, said
 * what to call it, and chose an action; this records exactly that. The previous
 * recorder collapsed adjacent typing and guessed which value varied, which was
 * the right thing to do with evidence that did not contain intent — and is the
 * wrong thing to do now that it does.
 */
async function addStep(step) {
  const rec = await getRecording()
  if (!rec) return { error: 'no recording in progress' }
  if (step.valueMode === 'dynamic') {
    const name = step.inputName || step.target
    if (!inputKey(name)) return { error: 'give the value a name the agent can pass it under' }
    const at = nameClash(rec.steps, name)
    if (at !== -1) return { error: clashMessage(rec.steps, at) }
  }
  rec.steps.push(step)
  if (step.origin && !rec.origins.includes(step.origin)) rec.origins.push(step.origin)
  await setRecording(rec)
  return { ok: true, steps: rec.steps.length }
}

/**
 * Change one step's value while still recording.
 *
 * The value is the only thing a recorded step lets you change — whether the
 * caller supplies it, and what it says. The action is not re-openable, here or
 * on the dashboard: a step you can rewrite into something nobody performed is a
 * step nobody checked.
 */
async function setStepValue(index, patch) {
  const rec = await getRecording()
  if (!rec) return { error: 'no recording in progress' }
  const step = rec.steps[index]
  if (!step) return { error: 'no such step' }
  if (step.kind !== 'type' && step.kind !== 'select') {
    return { error: 'only a step that types or chooses something carries a value' }
  }
  if (step.secret) return { error: 'a password is never recorded, so it has no value to change' }

  const mode = patch.valueMode ?? step.valueMode ?? 'static'
  if (mode === 'dynamic') {
    const name = patch.inputName ?? step.inputName ?? step.target
    if (!inputKey(name)) return { error: 'give the value a name the agent can pass it under' }
    const at = nameClash(rec.steps, name, index)
    if (at !== -1) return { error: clashMessage(rec.steps, at) }
  }

  if (patch.valueMode) step.valueMode = patch.valueMode
  if (typeof patch.sampleValue === 'string') step.sampleValue = patch.sampleValue
  if (patch.inputName) step.inputName = patch.inputName
  await setRecording(rec)
  return { ok: true, step }
}

/** Throw every step away and start the same workflow again. The only way to
 *  remove a step, deliberately: a recording you can edit in the middle is one
 *  where the steps no longer describe anything that was actually performed. */
async function restartRecording() {
  const rec = await getRecording()
  if (!rec) return { error: 'no recording in progress' }
  const dropped = rec.steps.length
  rec.steps = []
  await setRecording(rec)
  return { ok: true, dropped }
}

/** Throw a recording away entirely. */
async function discardRecording() {
  const rec = await getRecording()
  if (!rec) return { error: 'no recording in progress' }
  try {
    await chrome.tabs.sendMessage(rec.tabId, { t: 'record.end' })
  } catch {
    /* tab closed or navigated */
  }
  await setRecording(null)
  reflect({ ...state })
  log('recording discarded:', rec.name)
  return { ok: true, discarded: rec.steps.length }
}

async function saveRecording(description) {
  const rec = await getRecording()
  if (!rec) return { ok: false, error: 'no recording in progress' }
  if (!rec.name) return { ok: false, error: 'name the workflow before saving it' }
  if (!rec.steps.length) return { ok: false, error: 'add at least one step before saving' }

  const payload = {
    t: MSG.DRAFT_SAVE,
    name: rec.name,
    // What it is for, in the person's words. The one thing about a workflow
    // that is neither recorded nor derived, and the only thing that tells an
    // agent whether to reach for it.
    description: String(description ?? '').trim(),
    origins: rec.origins,
    raw: { startUrl: rec.startUrl, steps: rec.steps, recordedAt: new Date().toISOString() },
  }

  try {
    await chrome.tabs.sendMessage(rec.tabId, { t: 'record.end' })
  } catch {
    /* the tab may have been closed or navigated away */
  }

  await setRecording(null)

  if (isConnected()) {
    send(payload)
    log('draft saved:', rec.name, rec.steps.length, 'steps')
  } else {
    // Never drop a recording because the daemon happened to be down. Queue it
    // and flush on the next connect — re-recording is the one cost the user
    // cannot recover from.
    const bag = await chrome.storage.session.get(PENDING_KEY)
    const pending = bag[PENDING_KEY] ?? []
    pending.push(payload)
    await chrome.storage.session.set({ [PENDING_KEY]: pending })
    log('daemon offline; queued draft:', rec.name)
  }

  reflect({ ...state })
  return { ok: true, steps: rec.steps.length, name: rec.name }
}

/** Send anything recorded while the daemon was unreachable. */
async function flushPendingDrafts() {
  if (!isConnected()) return
  const bag = await chrome.storage.session.get(PENDING_KEY)
  const pending = bag[PENDING_KEY] ?? []
  if (!pending.length) return
  for (const payload of pending) send(payload)
  await chrome.storage.session.remove(PENDING_KEY)
  log('flushed', pending.length, 'queued draft(s)')
}

/**
 * A navigation destroys the content script, which would end the recording
 * silently mid-session. Put it back.
 */
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return
  const rec = await getRecording()
  if (!rec || rec.tabId !== tabId) return
  try {
    await injectPanel(tabId, rec)
    log('re-attached the panel after navigation')
  } catch (e) {
    log('could not re-attach the panel', e)
  }
})

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
        // Never leave the popup awaiting a response it will not get: an
        // unanswered sendMessage looks identical to "daemon is down".
        console.error('[atelier] connect failed', e)
      }
      // The daemon only pushes state on change, so a popup opened during a
      // quiet period would otherwise render the worker's stale cache.
      if (isConnected()) send({ t: MSG.STATE_REQUEST })
      sendResponse({
        state,
        // Read from session storage, not a module variable: the worker may have
        // been recycled since the recording started.
        recording: await getRecording(),
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
      sendResponse(await startRecording())
      break
    case 'panel.record.discard':
      sendResponse(await discardRecording())
      break
    case 'panel.step.repoint':
      sendResponse(await startRepoint(msg.workflowName, msg.stepId, msg.stepNote))
      break

    /* ---- from the in-page control panel ---- */
    case 'record.state':
      sendResponse({ recording: await getRecording() })
      break
    case 'record.name':
      sendResponse(await setName(msg.name))
      break
    case 'record.addStep':
      sendResponse(await addStep(msg.step))
      break
    case 'record.setStepValue':
      sendResponse(await setStepValue(msg.index, msg.patch ?? {}))
      break
    case 'record.restart':
      sendResponse(await restartRecording())
      break
    case 'record.save':
      sendResponse(await saveRecording(msg.description))
      break
    case 'record.discard':
      sendResponse(await discardRecording())
      break
    case 'record.repointDone':
      sendResponse(await finishRepoint(msg.pick))
      break
    /**
     * Ask the daemon on the popup's behalf.
     *
     * The popup asks it directly and only falls back to here — see `daemon()`
     * in panel.js for why it has to be able to. A worker has one thing the
     * popup does not: its requests are not a document's, and the browser
     * restriction that blocks the popup does not apply to them.
     */
    case 'panel.daemon':
      sendResponse(await daemon(msg.path, msg.body))
      break
    case 'panel.workflow.activate':
      sendResponse(await daemon('/api/workflows.activate', { name: msg.name }))
      break
    default:
      sendResponse({ ok: false })
  }
}

/* ------------------------------------------------------------ lifecycle */

chrome.runtime.onInstalled.addListener(() => {
  // The action opens a popup, declared in the manifest — there is nothing to
  // configure at runtime the way a side panel needed to be.
  chrome.alarms.create('atelier-keepalive', { periodInMinutes: 0.5 })
  connect()
})
chrome.runtime.onStartup.addListener(connect)
chrome.alarms.onAlarm.addListener(connect)

connect()
