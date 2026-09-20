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
    // A label the human recognises in the daemon log and in "waiting for X"
    // messages. Chrome's signed-in email is the best automatic guess; the point
    // is that nobody has to type it.
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
    // and the grant is now per origin rather than the whole web. A workflow
    // whose site was never approved parks with something the human can act on
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
 * Atelier no longer asks for every site up front.
 *
 * The origin allowlist has always been enforced by the daemon, but the manifest
 * still requested <all_urls>, so the browser had granted the extension the whole
 * web regardless — and the permission prompt is what a careful person actually
 * reads. Now the grant is requested per origin, at the moment the human points
 * at that site, and Chrome enforces what the security document promises.
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

/** Ask for the origins a workflow needs. Must be called from a user gesture, so
 *  this is only ever reached from the panel or the page bar. */
async function requestOrigins(origins) {
  const patterns = origins.map(originPattern).filter(Boolean)
  if (!patterns.length) return false
  try {
    return await chrome.permissions.request({ origins: patterns })
  } catch {
    return false
  }
}

/* -------------------------------------------------------- daemon (HTTP) */

/** The panel drives some things through the daemon's control API rather than
 *  the socket — anything that wants a reply the caller can act on. */
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
 * variable is gone by the time you press Stop, and every captured action goes
 * with it, silently. Session storage survives the worker and dies with the
 * browser, which is exactly the lifetime a recording wants.
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
}

async function injectRecorder(tabId, draftName, mode = 'workflow', count = 0) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/content/recorder.js'],
  })
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content/overlay.css'] })
  await chrome.tabs.sendMessage(tabId, { t: 'record.begin', draftName, mode, count })
}

async function startRecording(draftName) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('no active tab')
  const origin = originOf(tab.url)
  if (!origin) throw new Error('this page cannot be recorded — open the site you want to automate first')

  // Ask for this one origin, now, while we are inside the click that started
  // the recording. Recording a site we are not allowed to replay on would
  // produce a workflow that can never run.
  if (!(await hasOrigins([origin])) && !(await requestOrigins([origin]))) {
    throw new Error(`Atelier needs permission for ${origin} to record here`)
  }

  await setRecording({ draftName, tabId: tab.id, actions: [], origins: [origin], mode: 'workflow' })
  await injectRecorder(tab.id, draftName, 'workflow', 0)
  log('recording started:', draftName)
  reflect({ ...state })
}

const originOf = (url) => {
  try {
    const o = new URL(url).origin
    return o.startsWith('http') ? o : null
  } catch {
    return null
  }
}

/** Re-record one step of an existing workflow, in place. The repair path: a page
 *  that moved needs one step fixed, not twenty re-recorded. */
async function startStepRecording(workflowName, stepId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return { error: 'no active tab' }
  const origin = originOf(tab.url)
  if (!origin) return { error: 'open the workflow\'s site in this tab first' }
  if (!(await hasOrigins([origin])) && !(await requestOrigins([origin]))) {
    return { error: `Atelier needs permission for ${origin}` }
  }
  await setRecording({
    draftName: workflowName,
    tabId: tab.id,
    actions: [],
    origins: [origin],
    mode: 'step',
    workflowName,
    stepId,
  })
  await injectRecorder(tab.id, workflowName, 'step', 0)
  reflect({ ...state })
  return { ok: true }
}

/** Splice the single re-recorded action into the workflow and stand down. */
async function finishStepRecording() {
  const rec = await getRecording()
  if (!rec || rec.mode !== 'step') return { error: 'no step recording in progress' }
  const action = rec.actions[rec.actions.length - 1]
  await setRecording(null)
  reflect({ ...state })
  if (!action) return { error: 'nothing was captured' }
  send({ t: MSG.STEP_RERECORD, workflowName: rec.workflowName, stepId: rec.stepId, action })
  log('re-recorded step', rec.stepId, 'of', rec.workflowName)
  return { ok: true }
}

/** Throw a recording away. Its own control, because the alternative — saving
 *  something you did not mean to keep and deleting it afterwards — leaves a
 *  half-made workflow in the list in the meantime. */
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
  log('recording discarded:', rec.draftName)
  return { ok: true, discarded: rec.actions.length }
}

/** Remove the last thing recorded. A recorder that cannot take something back
 *  makes you restart from the beginning over one stray click. */
async function undoLastAction() {
  const rec = await getRecording()
  if (!rec) return 0
  rec.actions.pop()
  await setRecording(rec)
  chrome.runtime.sendMessage({ t: 'panel.recording', recording: { name: rec.draftName, actions: rec.actions } }).catch(() => {})
  return rec.actions.length
}

/**
 * Mark a recorded field as the thing that varies between runs, or as setup to
 * be replayed exactly.
 *
 * The proposal pass guesses by taking the longest typed value, which is right
 * for the common recording and exactly wrong for one that types a long constant
 * into one field and a short varying thing into another — there is nothing in
 * the trace that distinguishes the two. Only the person doing the task knows,
 * and the moment they know it is while they are doing it, so the mark is made
 * against the list in the panel rather than asked for afterwards.
 */
async function setActionRole(index, role) {
  const rec = await getRecording()
  if (!rec) return { error: 'no recording in progress' }
  const action = rec.actions[index]
  if (!action) return { error: 'no such action' }
  if (action.kind !== 'type') return { error: 'only a typed field can be an input' }
  if (action.secret) return { error: 'a password is never recorded, so it cannot be an input' }
  // Clearing is a role of its own: it hands the field back to the guess rather
  // than pinning it to whichever side the panel happened to show first.
  if (role) action.role = role
  else delete action.role
  await setRecording(rec)
  chrome.runtime
    .sendMessage({ t: 'panel.recording', recording: { name: rec.draftName, actions: rec.actions, mode: rec.mode } })
    .catch(() => {})
  return { ok: true, role: action.role ?? null }
}

/** The identity a field is known by, and the same one the proposal pass uses to
 *  collapse: the best selector it was recorded with. */
function fieldKey(element) {
  const best = [...(element?.selectors ?? [])].sort((a, b) => b.score - a.score)[0]
  return best ? `${best.strategy}:${best.value}` : null
}

/**
 * Typing into the field you are already typing into is not another step.
 *
 * The recorder debounces per field, but any pause longer than the debounce emits
 * a second action — so a sentence with a thought in the middle of it arrived as
 * two, and going back to fix a word made three. `propose.ts` has always
 * collapsed those, but not until the recording became a workflow, which left
 * every screen before that — the count on the bar, the popup's list, the review
 * — showing bursts of keystrokes as if they were steps.
 *
 * Only against the immediately preceding action, which is what keeps this a
 * merge rather than a rewrite: type here, click there, type here again is three
 * things that happened, in the order replay has to follow them.
 */
function mergesInto(previous, action) {
  if (!previous || previous.kind !== 'type' || action.kind !== 'type') return false
  if (previous.secret !== action.secret) return false
  const key = fieldKey(action.element)
  return key !== null && key === fieldKey(previous.element)
}

async function addAction(action) {
  const rec = await getRecording()
  if (!rec) return 0
  const previous = rec.actions[rec.actions.length - 1]
  if (mergesInto(previous, action)) {
    // The later value is the complete one. The role is not: it was set against
    // the field, and going back to correct a typo should not undo it.
    rec.actions[rec.actions.length - 1] = { ...action, ...(previous.role ? { role: previous.role } : {}) }
    if (action.origin && !rec.origins.includes(action.origin)) rec.origins.push(action.origin)
    await setRecording(rec)
    chrome.runtime
      .sendMessage({ t: 'panel.recording', recording: { name: rec.draftName, actions: rec.actions, mode: rec.mode } })
      .catch(() => {})
    return rec.actions.length
  }
  rec.actions.push(action)
  if (action.origin && !rec.origins.includes(action.origin)) rec.origins.push(action.origin)
  await setRecording(rec)
  // Push the whole list, not a count. A recorder that only tells you how many
  // things it heard cannot tell you it heard the wrong thing — which is how two
  // recordings came back missing the step that mattered.
  chrome.runtime
    .sendMessage({ t: 'panel.recording', recording: { name: rec.draftName, actions: rec.actions, mode: rec.mode } })
    .catch(() => {})
  return rec.actions.length
}

async function saveRecording() {
  const rec = await getRecording()
  if (!rec) {
    log('stop requested with no recording in progress')
    return { ok: false, error: 'no recording in progress' }
  }

  const payload = {
    t: MSG.DRAFT_SAVE,
    name: rec.draftName,
    origins: rec.origins,
    raw: { actions: rec.actions, recordedAt: new Date().toISOString() },
  }

  try {
    await chrome.tabs.sendMessage(rec.tabId, { t: 'record.end' })
  } catch {
    /* the tab may have been closed or navigated away */
  }

  await setRecording(null)

  if (isConnected()) {
    send(payload)
    log('draft saved:', rec.draftName, rec.actions.length, 'actions')
  } else {
    // Never drop a recording because the daemon happened to be down. Queue it
    // and flush on the next connect — re-recording is the one cost the user
    // cannot recover from.
    const bag = await chrome.storage.session.get(PENDING_KEY)
    const pending = bag[PENDING_KEY] ?? []
    pending.push(payload)
    await chrome.storage.session.set({ [PENDING_KEY]: pending })
    log('daemon offline; queued draft:', rec.draftName)
  }

  reflect({ ...state })
  return { ok: true, actions: rec.actions.length }
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
    await injectRecorder(tabId, rec.draftName, rec.mode ?? 'workflow', rec.actions.length)
    log('re-attached recorder after navigation')
  } catch (e) {
    log('could not re-attach recorder', e)
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
        // Never leave the panel awaiting a response it will not get: an
        // unanswered sendMessage looks identical to "daemon is down".
        console.error('[atelier] connect failed', e)
      }
      // The daemon only pushes state on change, so a panel opened during a
      // quiet period would otherwise render the worker's stale cache.
      if (isConnected()) send({ t: MSG.STATE_REQUEST })
      // Read from session storage, not a module variable: the worker may have
      // been recycled since the recording started.
      const rec = await getRecording()
      sendResponse({
        state,
        recording: rec ? { name: rec.draftName, actions: rec.actions, mode: rec.mode ?? 'workflow' } : null,
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
      sendResponse(await saveRecording())
      break
    case 'record.action': {
      // addAction persists to session storage. It used to be dead code behind a
      // module variable that did not exist, which meant every recorded action
      // threw and was silently dropped — the recording always came back empty.
      const total = await addAction(msg.action)
      sendResponse({ ok: true, count: total })
      break
    }
    // The page asks for the recording so far, to review it before saving. The
    // popup gets the same thing from panel.hello; this is the same read, asked
    // for by the surface the person is actually looking at.
    case 'record.list': {
      const rec = await getRecording()
      sendResponse(rec ? { name: rec.draftName, actions: rec.actions } : { error: 'no recording in progress' })
      break
    }
    case 'record.role':
      sendResponse(await setActionRole(msg.index, msg.role))
      break
    case 'record.undo': {
      const total = await undoLastAction()
      sendResponse({ ok: true, count: total })
      break
    }
    case 'record.saveFromPage':
      sendResponse(await saveRecording())
      break
    case 'record.discardFromPage':
      sendResponse(await discardRecording())
      break
    case 'record.stepDone':
      sendResponse(await finishStepRecording())
      break
    case 'panel.record.discard':
      sendResponse(await discardRecording())
      break
    case 'panel.step.rerecord':
      sendResponse(await startStepRecording(msg.workflowName, msg.stepId))
      break
    case 'panel.workflow.activate': {
      const res = await daemon('/api/workflows.activate', { name: msg.name })
      sendResponse(res)
      break
    }
    case 'panel.workflow.removeStep': {
      const res = await daemon('/api/workflows.removeStep', { name: msg.name, stepId: msg.stepId })
      sendResponse(res)
      break
    }
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
