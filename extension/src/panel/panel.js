/**
 * The popup behind the toolbar icon.
 *
 * Its whole job is the one or two things that need a person *right now*, on the
 * page they are looking at. A popup closes the moment it loses focus, so it is
 * not where a recording is driven from and not where anything is read at
 * length: the control panel over the page carries the recording, and the
 * dashboard carries everything else.
 *
 * Which is why this lists only the workflows recorded on the current site, and
 * says how many live elsewhere rather than showing them. A list you have to
 * scan past to find the two entries that apply to where you are standing is a
 * list that costs more than it gives.
 */

const $ = (id) => document.getElementById(id)

const els = {
  offline: $('offline'),
  offlineWhy: $('offline-why'),
  retry: $('retry'),
  blockedSection: $('blocked-section'),
  blocked: $('blocked'),
  runningSection: $('running-section'),
  running: $('running'),
  hereLabel: $('here-label'),
  here: $('here'),
  hereEmpty: $('here-empty'),
  record: $('record'),
  recordLabel: $('record-label'),
  recordLive: $('record-live'),
  elsewhere: $('elsewhere'),
  dashboardLink: $('dashboard-link'),
  modal: $('modal'),
  modalTitle: $('modal-title'),
  modalBody: $('modal-body'),
  modalGo: $('modal-go'),
  modalStop: $('modal-stop'),
}

let recording = null
/** The origin of the tab the popup was opened over. The filter this whole
 *  screen is built around. */
let here = null
/** The port the daemon last reported being on, for when we could not probe. */
let lastPort = null

/* --------------------------------------------------------------- dialog */

/**
 * Atelier's own confirm.
 *
 * `window.confirm` blocks the extension's event loop, cannot be styled, and
 * — worst of all here — is raised by a document that is about to be destroyed,
 * because a popup closes when it loses focus. Its own element has none of those
 * problems.
 */
function ask({ title, body, confirm, onConfirm }) {
  els.modalTitle.textContent = title
  els.modalBody.textContent = body ?? ''
  els.modalBody.hidden = !body
  els.modalGo.textContent = confirm
  els.modal.hidden = false
  els.modalGo.onclick = async () => {
    els.modal.hidden = true
    await onConfirm()
  }
  els.modalStop.onclick = () => {
    els.modal.hidden = true
  }
}

/** A message that is not a question. Where `alert` used to be. */
function tell(title, body) {
  ask({ title, body, confirm: 'OK', onConfirm: async () => {} })
  els.modalStop.hidden = true
  els.modalGo.onclick = () => {
    els.modal.hidden = true
    els.modalStop.hidden = false
  }
}

/* --------------------------------------------------------------- render */

function jobCard(job, { alert = false } = {}) {
  const li = document.createElement('li')
  li.className = `card${alert ? ' alert' : ''}`

  const title = document.createElement('div')
  title.className = 'card-title'
  title.textContent = job.workflowName + (job.isTest ? ' · test run' : '')
  li.append(title)

  const sub = document.createElement('div')
  sub.className = 'card-sub'
  sub.textContent = alert
    ? job.blockedReason || 'Paused.'
    : `Step ${job.stepIndex + 1} of ${job.stepCount}`
  li.append(sub)

  if (alert) {
    const actions = document.createElement('div')
    actions.className = 'actions'

    const resume = document.createElement('button')
    resume.className = 'primary'
    resume.textContent = 'Resume'
    // Retries the step it stopped on, so "I fixed it" is the whole interaction.
    resume.onclick = async () => {
      resume.disabled = true
      try {
        await daemon('/api/jobs.resume', { id: job.id })
      } finally {
        await refresh()
      }
    }

    const cancel = document.createElement('button')
    cancel.className = 'ghost'
    cancel.textContent = 'Cancel'
    cancel.onclick = async () => {
      cancel.disabled = true
      try {
        await daemon('/api/jobs.cancel', { id: job.id })
      } finally {
        await refresh()
      }
    }

    actions.append(resume, cancel)
    li.append(actions)
  } else {
    const bar = document.createElement('div')
    bar.className = 'bar'
    const fill = document.createElement('i')
    fill.style.width = `${job.stepCount ? (job.stepIndex / job.stepCount) * 100 : 0}%`
    bar.append(fill)
    li.append(bar)
  }
  return li
}

/** One workflow recorded on this site. The row opens its page on the dashboard;
 *  the two buttons are the things worth doing without leaving the browser. */
function workflowRow(w) {
  const li = document.createElement('li')
  li.className = `wf status-${w.status}`

  const head = document.createElement('button')
  head.className = 'wf-head'
  head.title = 'Open this workflow on the dashboard'
  head.onclick = () => openDashboard(`#workflow/${encodeURIComponent(w.name)}`)

  const name = document.createElement('span')
  name.className = 'wf-name'
  name.textContent = w.name
  head.append(name)

  // One chip, and only when it is not the ordinary case. A row of badges saying
  // "active · healthy · 12 runs" is a row nobody reads.
  const chip = chipFor(w)
  if (chip) head.append(chip)
  li.append(head)

  const meta = document.createElement('div')
  meta.className = 'wf-meta'
  meta.textContent = `${w.steps} steps · produces ${w.produces}`
  li.append(meta)

  const actions = document.createElement('div')
  actions.className = 'actions'

  if (w.status === 'draft') {
    const go = document.createElement('button')
    go.className = 'primary'
    go.textContent = 'Activate'
    go.onclick = async () => {
      go.disabled = true
      try {
        await daemon('/api/workflows.activate', { name: w.name })
      } catch (e) {
        tell('Could not activate', e.message)
      } finally {
        await refresh()
      }
    }
    actions.append(go)
  }

  if (w.status !== 'disabled') {
    const test = document.createElement('button')
    test.className = 'ghost'
    test.textContent = 'Test run'
    test.title = 'Run it with the values it was recorded with'
    test.onclick = async () => {
      test.disabled = true
      try {
        await daemon('/api/workflows.test', { name: w.name })
      } catch (e) {
        tell('Could not start the test', e.message)
      } finally {
        await refresh()
      }
    }
    actions.append(test)
  }

  li.append(actions)

  // Repointing has to happen here and nowhere else: it needs the page open, and
  // the page is open. Only the steps that are actually decaying get a control —
  // listing twenty healthy ones to reach the two that moved is not help.
  for (const step of w.health?.degraded ?? []) {
    li.append(repointRow(w, step))
  }
  return li
}

/** One decaying step, and the one thing worth doing about it. */
function repointRow(workflow, step) {
  const row = document.createElement('div')
  row.className = 'step-row'

  const label = document.createElement('span')
  label.className = 'step-note'
  label.textContent = step.note
  label.title = step.detail

  const fix = document.createElement('button')
  fix.className = 'ghost tiny'
  fix.textContent = 'Repoint'
  fix.title = 'Point this one step at the element it should use now. Nothing else changes.'
  fix.onclick = async () => {
    fix.disabled = true
    const res = await worker({
      t: 'panel.step.repoint',
      workflowName: workflow.name,
      stepId: step.stepId,
      stepNote: step.note,
    })
    fix.disabled = false
    if (res?.error) return tell('Could not start', res.error)
    // The panel over the page takes it from here, and this window is about to
    // lose focus anyway.
    window.close()
  }

  row.append(label, fix)
  return row
}

function chipFor(w) {
  const chip = document.createElement('span')
  chip.className = 'chip'
  if (w.status === 'draft') {
    chip.classList.add('chip-go')
    chip.textContent = 'not active yet'
    return chip
  }
  if (w.status === 'disabled') {
    chip.classList.add('chip-off')
    chip.textContent = 'disabled'
    return chip
  }
  const health = w.health?.state
  if (health === 'fragile' || health === 'degraded') {
    chip.classList.add(`chip-${health}`)
    chip.textContent = health === 'fragile' ? 'about to break' : 'decaying'
    return chip
  }
  return null
}

function render(state, daemonUp, browsers = []) {
  // Two different failures, two different fixes. Conflating them is what made
  // the old banner give the wrong instruction most of the time.
  const attached = browsers.length > 0
  els.offline.hidden = daemonUp && attached
  if (!daemonUp) {
    els.offlineWhy.textContent = 'No daemon on 127.0.0.1. Start it, and this will reconnect.'
  } else if (!attached) {
    els.offlineWhy.textContent =
      'The daemon is running, but this browser has not attached. Reload Atelier at chrome://extensions.'
  }

  const blocked = state.jobs.filter((j) => j.status === 'blocked')
  const running = state.jobs.filter((j) => j.status === 'running' || j.status === 'queued')

  els.blockedSection.hidden = blocked.length === 0
  els.blocked.replaceChildren(...blocked.map((j) => jobCard(j, { alert: true })))

  els.runningSection.hidden = running.length === 0
  els.running.replaceChildren(...running.map((j) => jobCard(j)))

  const all = state.workflows ?? []
  const mine = here ? all.filter((w) => (w.origins ?? []).includes(here)) : []
  const others = all.length - mine.length

  els.hereLabel.textContent = here ? `On ${hostOf(here)}` : 'On this page'
  els.here.replaceChildren(...mine.map(workflowRow))
  els.hereEmpty.hidden = mine.length > 0
  els.hereEmpty.textContent = here
    ? 'Nothing recorded on this site yet.'
    : 'Open the site you want to automate, then record.'

  // A count, not a list. Managing what is not in front of you is the
  // dashboard's job, and saying how much there is keeps the filter honest.
  els.elsewhere.textContent = others
    ? `${others} more workflow${others === 1 ? '' : 's'} elsewhere in this project`
    : ''
}

const hostOf = (origin) => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function renderRecording() {
  const on = !!recording
  els.record.classList.toggle('recording', on)
  els.record.disabled = on
  els.recordLabel.textContent = on
    ? `Recording ${recording.name ? `“${recording.name}”` : '— name it in the page'}`
    : 'Record a workflow'
  els.recordLive.hidden = !on
  if (on) {
    const n = recording.steps?.length ?? 0
    els.recordLive.textContent =
      `${n} step${n === 1 ? '' : 's'} so far. The control panel is over the page — ` +
      'the orange A in the corner opens it.'
  }
}

/* --------------------------------------------------------------- events */

/**
 * Start recording, and get out of the way.
 *
 * The popup closes immediately and the workflow is named in the page, because
 * a popup dies the moment it loses focus and the very next thing anybody does
 * after pressing this is look at the page. Asking for a name here meant the
 * question and the thing it is about were never on screen together.
 *
 * The site permission is requested from here, though: `permissions.request`
 * needs a user gesture, and this click is the last one Atelier gets.
 */
els.record.onclick = async () => {
  if (recording) return
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const origin = originOf(tab?.url)
  if (!origin) {
    return tell(
      'Nothing to record here',
      'Open the site you want to automate in this tab, then press Record again.',
    )
  }

  const pattern = `${origin}/*`
  const granted =
    (await chrome.permissions.contains({ origins: [pattern] })) ||
    (await chrome.permissions.request({ origins: [pattern] }))
  if (!granted) {
    return tell(
      'Atelier needs this site',
      `Recording on ${hostOf(origin)} means being allowed to act on it later. Nothing else is requested.`,
    )
  }

  const res = await worker({ t: 'panel.record.start' })
  if (res?.error) return tell('Could not start recording', res.error)
  window.close()
}

const originOf = (url) => {
  try {
    const o = new URL(url).origin
    return o.startsWith('http') ? o : null
  } catch {
    return null
  }
}

els.retry.onclick = async () => {
  els.offlineWhy.textContent = 'Checking…'
  daemonPort = null
  await refresh()
}

function openDashboard(hash) {
  // Whatever the overview last said, when the popup could not find the port
  // itself. A link that silently does nothing is worse than a wrong port.
  const port = daemonPort ?? lastPort
  if (!port) return
  chrome.tabs.create({ url: `http://127.0.0.1:${port}/${hash ?? ''}` })
}

/* ----------------------------------------------------------- the daemon */

/**
 * The popup asks the daemon directly, and asks the worker when it cannot.
 *
 * Directly first, because that is the honest way round: the popup is an
 * extension page with host permissions for 127.0.0.1, and routing its reads
 * through the service worker used to mean a sleeping or wedged worker made the
 * popup claim the daemon was down — an MV3 listener that returns `true`
 * without calling sendResponse hangs the caller forever, with no error
 * anywhere. The worker is needed to *drive* a browser; it is not needed to
 * *describe* one.
 *
 * The fallback is not defensiveness. Chrome now gates requests to the loopback
 * address space behind Local Network Access, and it gates them per *document*:
 * every fetch from this page was refused — "Permission was denied for this
 * request to access the `loopback` address space" — while the service worker's
 * went through untouched, which is why recording kept working and every button
 * in here quietly did nothing. The manifest asks for `localNetworkAccess`,
 * which is the proper fix; this is what makes the popup work on a browser that
 * refuses anyway, and it costs one message hop on a path that was already
 * failing.
 *
 * Only a *transport* failure falls back. An error the daemon itself returned is
 * an answer, and asking a second time down a different road would not change it.
 */
const PORTS = [7717, 7718, 7719, 7720]
let daemonPort = null
/** Set once the direct road is known not to work, for this popup's lifetime. */
let throughWorker = false

async function findDaemon() {
  const candidates = daemonPort ? [daemonPort, ...PORTS] : PORTS
  for (const port of candidates) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(700),
      })
      if (res.ok) return port
    } catch {
      /* not this one */
    }
  }
  return null
}

async function direct(path, body) {
  if (!daemonPort) daemonPort = await findDaemon()
  if (!daemonPort) throw new Error('no daemon')
  const res = await fetch(`http://127.0.0.1:${daemonPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  })
  const payload = await res.json()
  if (payload.ok === false) {
    // The daemon answered, and the answer was no. Marked so the caller knows
    // not to go looking for a second opinion.
    const said = new Error(payload.error || 'daemon error')
    said.fromDaemon = true
    throw said
  }
  return payload.result
}

async function throughTheWorker(path, body) {
  const res = await worker({ t: 'panel.daemon', path, body }, 6000)
  if (!res || res.error) throw new Error(res?.error || 'the extension background did not answer')
  return res.result
}

async function daemon(path, body = {}) {
  if (throughWorker) return throughTheWorker(path, body)
  try {
    return await direct(path, body)
  } catch (e) {
    if (e?.fromDaemon) throw e
    // Could not get a request out at all. Once is enough to stop trying.
    throughWorker = true
    daemonPort = null
    return throughTheWorker(path, body)
  }
}

/* ------------------------------------------------ the service worker */

/**
 * Recording needs tabs and scripting, so it has to go through the worker. Every
 * call is bounded: a worker that accepts a message and never answers must not
 * be able to freeze a button.
 */
async function worker(msg, timeoutMs = 3000) {
  return Promise.race([
    chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e) })),
    new Promise((r) => setTimeout(() => r({ error: 'the extension background did not respond' }), timeoutMs)),
  ])
}

/* ------------------------------------------------------------ polling */

let timer = null

async function refresh() {
  try {
    const o = await daemon('/api/overview')
    lastPort = o.port ?? lastPort
    render({ jobs: o.jobs, workflows: o.workflows }, true, o.browsers)
    // The port is discovered, so the link cannot be a static href — and when
    // the popup could not probe for it, the overview says which one answered.
    els.dashboardLink.href = `http://127.0.0.1:${daemonPort ?? o.port}/`
  } catch {
    daemonPort = null
    render({ jobs: [], workflows: [] }, false, [])
  }
}

function startPolling() {
  clearInterval(timer)
  // Localhost, a few hundred bytes. Cheap enough that push would be a
  // complication rather than an optimisation.
  timer = setInterval(refresh, 2000)
}

/*
 * Refresh the moment the document becomes visible rather than waiting for the
 * next tick. A popup is destroyed when it closes, so this now mostly matters on
 * the first paint — but Chrome throttles timers hard in any document that is not
 * visible, and this is what stopped the popup looking frozen on changes made
 * while it was in the background.
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh()
})
window.addEventListener('focus', () => refresh())

// Keep listening for worker pushes — they arrive sooner than the next poll —
// but never depend on them.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.t === 'panel.state' || msg.t === 'panel.connection') refresh()
  if (msg.t === 'panel.recording') {
    recording = msg.recording
    renderRecording()
  }
})

;(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  here = originOf(tab?.url)
  const boot = await worker({ t: 'panel.hello' })
  recording = boot?.recording ?? null
  renderRecording()
  await refresh()
  startPolling()
})()
