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
  dialog: $('name-dialog'),
  nameInput: $('name-input'),
  offlineWhy: $('offline-why'),
  retry: $('retry'),
  stamp: $('stamp'),
  recordDone: $('record-done'),
  draftsSection: $('drafts-section'),
  drafts: $('drafts'),
  dashboardLink: $('dashboard-link'),
}

/** Bumped with the manifest. Shown in the panel so "am I running the new code?"
 *  is answerable by looking, not by guessing — we mistook a stale build for a
 *  dead backend twice. */
const PANEL_BUILD = '0.2.0'

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

function render(state, daemonUp, browsers = []) {
  connected = !!daemonUp
  // Two different failures, two different fixes. Conflating them is what made
  // the old banner give the wrong instruction most of the time.
  const attached = browsers.length > 0
  els.offline.hidden = connected && attached
  if (!connected) {
    els.offlineWhy.textContent =
      'No daemon on 127.0.0.1. Start Claude Code, or run npm start in atelier/.'
  } else if (!attached) {
    els.offlineWhy.textContent =
      'The daemon is running, but this browser has not attached yet. Reload Atelier at chrome://extensions.'
  }

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

  // Drafts are Claude's move, not the human's — so these are named, not
  // actionable. Seeing them is the point: an unreviewed recording is invisible
  // work, and invisible work gets re-recorded.
  const drafts = state.draftList || []
  els.draftsSection.hidden = drafts.length === 0
  els.drafts.replaceChildren(
    ...drafts.map((d) => {
      const li = document.createElement('li')
      li.className = 'card'
      const title = document.createElement('div')
      title.className = 'card-title'
      title.textContent = d.name
      const sub = document.createElement('div')
      sub.className = 'card-sub'
      sub.textContent = `${d.actions} actions · ask Claude Code to review drafts`
      li.append(title, sub)
      return li
    }),
  )
}

function renderRecording() {
  els.record.classList.toggle('recording', !!recording)
  // The count is the reassurance that actions are actually being captured —
  // without it, a long wait for a render looks identical to a dead recorder.
  const n = recording?.actions ?? 0
  els.recordLabel.textContent = recording
    ? `Stop “${recording.name}”${n ? ` · ${n} action${n === 1 ? '' : 's'}` : ''}`
    : 'Record a workflow'
  els.recordHint.hidden = !recording
  if (recording) els.recordDone.hidden = true
}

/* --------------------------------------------------------------- events */

els.record.onclick = async () => {
  if (recording) {
    const res = await worker({ t: 'panel.record.stop' })
    if (res?.error) return alert(`Could not stop recording: ${res.error}`)
    const n = res?.actions ?? 0
    recording = null
    renderRecording()
    // Saying where it went matters: a recording is not yet a workflow, and the
    // next move is Claude's, not the user's.
    els.recordDone.textContent =
      `Saved ${n} action${n === 1 ? '' : 's'} as a draft. Ask Claude Code to review drafts to turn it into a workflow.`
    els.recordDone.hidden = false
    await refresh()
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
  const res = await worker({ t: 'panel.record.start', name })
  if (res?.error) {
    alert(`Could not start recording: ${res.error}\n\nReload Atelier at chrome://extensions and try again.`)
    return
  }
  recording = { name }
  renderRecording()
})

/* ----------------------------------------------------------- the daemon */

/**
 * The panel talks to the daemon directly.
 *
 * It used to ask the service worker, which meant a sleeping or wedged worker
 * made the panel claim the daemon was down — and an MV3 listener that returns
 * `true` without calling sendResponse hangs the caller forever, with no error
 * anywhere. The panel is an extension page with host permissions for
 * 127.0.0.1, so it can just ask. The worker is still needed to *drive* a
 * browser; it is not needed to *describe* one.
 */
const PORTS = [7717, 7718, 7719, 7720]
let daemonPort = null

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

async function daemon(path, body = {}) {
  if (!daemonPort) daemonPort = await findDaemon()
  if (!daemonPort) throw new Error('no daemon')
  const res = await fetch(`http://127.0.0.1:${daemonPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  })
  const payload = await res.json()
  if (payload.ok === false) throw new Error(payload.error || 'daemon error')
  return payload.result
}

/* ----------------------------------------------------------- the service worker */

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

/* ------------------------------------------------------------------ polling */

let timer = null

async function refresh() {
  try {
    const o = await daemon('/api/overview')
    render(
      { jobs: o.jobs, drafts: o.counts.drafts, draftList: o.drafts, workflows: o.workflows },
      true,
      o.browsers,
    )
    // The port is discovered, so the link cannot be a static href.
    els.dashboardLink.href = `http://127.0.0.1:${daemonPort}/`
    els.stamp.textContent =
      `panel ${PANEL_BUILD} · daemon ${o.version} on :${daemonPort} · ` +
      `${o.browsers.length} browser${o.browsers.length === 1 ? '' : 's'} attached`
  } catch (e) {
    daemonPort = null
    render({ jobs: [], drafts: 0, workflows: [] }, false, [])
    els.stamp.textContent = `panel ${PANEL_BUILD} · daemon unreachable (${e.message})`
  }
}

function startPolling() {
  clearInterval(timer)
  // Localhost, a few hundred bytes. Cheap enough that push would be a
  // complication rather than an optimisation.
  timer = setInterval(refresh, 2000)
}

els.retry.onclick = async () => {
  els.offlineWhy.textContent = 'Checking…'
  daemonPort = null
  await refresh()
}

// Keep listening for worker pushes — they arrive sooner than the next poll —
// but never depend on them.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.t === 'panel.state') refresh()
  if (msg.t === 'panel.connection') refresh()
  if (msg.t === 'panel.recordCount' && recording) {
    recording.actions = msg.count
    renderRecording()
  }
})

;(async () => {
  const boot = await worker({ t: 'panel.hello' })
  recording = boot?.recording ?? null
  renderRecording()
  await refresh()
  startPolling()
})()
