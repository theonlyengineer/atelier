/**
 * The side panel. Renders whatever the service worker last heard from the
 * daemon — it never polls, never computes state, and never asks a question the
 * system could answer itself.
 */

const $ = (id) => document.getElementById(id)

const els = {
  offline: $('offline'),
  blockedSection: $('blocked-section'),
  blocked: $('blocked'),
  runningSection: $('running-section'),
  running: $('running'),
  record: $('record'),
  recordLabel: $('record-label'),
  recordHint: $('record-hint'),
  workflows: $('workflows'),
  workflowCount: $('workflow-count'),
  draftsNote: $('drafts-note'),
  dialog: $('name-dialog'),
  nameInput: $('name-input'),
  offlineWhy: $('offline-why'),
  retry: $('retry'),
}

let recording = null
let connected = false

/* --------------------------------------------------------------- render */

function card(job, { alert = false } = {}) {
  const li = document.createElement('li')
  li.className = `card${alert ? ' alert' : ''}`

  const title = document.createElement('div')
  title.className = 'card-title'
  title.textContent = job.workflowName
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
    resume.onclick = () => chrome.runtime.sendMessage({ t: 'panel.resume', jobId: job.id })

    const cancel = document.createElement('button')
    cancel.className = 'ghost'
    cancel.textContent = 'Cancel'
    cancel.onclick = () => chrome.runtime.sendMessage({ t: 'panel.cancel', jobId: job.id })

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

function render(state, isConnected) {
  connected = !!isConnected
  els.offline.hidden = connected

  const blocked = state.jobs.filter((j) => j.status === 'blocked')
  const running = state.jobs.filter((j) => j.status === 'running' || j.status === 'queued')

  els.blockedSection.hidden = blocked.length === 0
  els.blocked.replaceChildren(...blocked.map((j) => card(j, { alert: true })))

  els.runningSection.hidden = running.length === 0
  els.running.replaceChildren(...running.map((j) => card(j)))

  els.workflowCount.textContent = String(state.workflows.length)
  if (state.workflows.length) {
    els.workflows.replaceChildren(
      ...state.workflows.map((w) => {
        const li = document.createElement('li')
        li.className = 'wf'
        const name = document.createElement('div')
        name.className = 'wf-name'
        name.textContent = w.name
        const meta = document.createElement('div')
        meta.className = 'wf-meta'
        meta.textContent = `produces ${w.produces}`
        li.append(name, meta)
        return li
      }),
    )
  } else {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = 'Nothing recorded yet.'
    els.workflows.replaceChildren(li)
  }

  // Drafts are Claude's move, not the human's, so this is a note rather than a
  // button — there is nothing here for them to click.
  els.draftsNote.hidden = !state.drafts
  if (state.drafts) {
    els.draftsNote.textContent = `${state.drafts} recording${state.drafts === 1 ? '' : 's'} waiting for Claude to review. Ask it to check drafts.`
  }
}

function renderRecording() {
  els.record.classList.toggle('recording', !!recording)
  els.recordLabel.textContent = recording ? `Stop “${recording.name}”` : 'Record a workflow'
  els.recordHint.hidden = !recording
}

/* --------------------------------------------------------------- events */

els.record.onclick = async () => {
  if (recording) {
    await chrome.runtime.sendMessage({ t: 'panel.record.stop' })
    recording = null
    renderRecording()
    return
  }
  els.nameInput.value = ''
  els.dialog.showModal()
  els.nameInput.focus()
}

els.dialog.addEventListener('close', async () => {
  if (els.dialog.returnValue !== 'ok') return
  const raw = els.nameInput.value.trim()
  if (!raw) return
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  await chrome.runtime.sendMessage({ t: 'panel.record.start', name })
  recording = { name }
  renderRecording()
})

chrome.runtime.onMessage.addListener((msg) => {
  // A state frame is proof of a live socket, so it doubles as a connection ping.
  if (msg.t === 'panel.state') render(msg.state, true)
  if (msg.t === 'panel.connection') {
    connected = !!msg.connected
    els.offline.hidden = connected
    if (connected) stopRetrying()
    else scheduleRetry()
  }
})

/**
 * Ask the service worker where we stand.
 *
 * This has to be a loop, not a single question at open. The panel can be opened
 * before the daemon is up, while the socket is mid-reconnect, or after MV3 has
 * torn the service worker down — and in every one of those cases the honest
 * first answer is "no" and the right behaviour is to ask again shortly.
 */
async function poll() {
  let boot
  try {
    boot = await chrome.runtime.sendMessage({ t: 'panel.hello' })
  } catch {
    // The service worker was asleep and this message woke it; it will answer
    // the next one. Distinguish it from a dead daemon, because the fix differs.
    els.offlineWhy.textContent = 'Waking the extension…'
    return false
  }
  if (!boot) {
    els.offlineWhy.textContent = 'The extension background is not responding. Reload it at chrome://extensions.'
    return false
  }
  recording = boot.recording ?? null
  renderRecording()
  render(boot.state ?? { jobs: [], drafts: 0, workflows: [] }, boot.connected)
  if (!boot.connected) {
    els.offlineWhy.textContent = boot.port
      ? `Found the daemon on port ${boot.port} but the connection is not open yet…`
      : 'No daemon on 127.0.0.1. Start Claude Code, or run npm start in atelier/.'
  }
  return !!boot.connected
}

let retryTimer = null

function stopRetrying() {
  clearTimeout(retryTimer)
  retryTimer = null
}

function scheduleRetry(delay = 2000) {
  stopRetrying()
  retryTimer = setTimeout(async () => {
    const ok = await poll()
    if (!ok) scheduleRetry(Math.min(delay * 1.5, 15000))
  }, delay)
}

els.retry.onclick = async () => {
  els.offlineWhy.textContent = 'Checking…'
  if (!(await poll())) scheduleRetry(2000)
}

if (!(await poll())) scheduleRetry(1000)
