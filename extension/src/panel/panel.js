/**
 * The popup behind the toolbar icon. Renders whatever the service worker last
 * heard from the daemon — it never polls, never computes state, and never asks a
 * question the system could answer itself.
 *
 * A popup closes the moment it loses focus, so it is not where a recording is
 * driven from: the in-page bar carries Capture, Wait, Undo and Save while the
 * person is working in the page. This is where you look at what was heard, and
 * mark which fields vary between runs, once the typing is done.
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
  workflows: $('workflows'),
  workflowCount: $('workflow-count'),
  dialog: $('name-dialog'),
  nameInput: $('name-input'),
  offlineWhy: $('offline-why'),
  retry: $('retry'),
  stamp: $('stamp'),
  recordDone: $('record-done'),
  workflowsDetails: $('workflows-details'),
  dashboardLink: $('dashboard-link'),
  pendingSection: $('pending-section'),
  pending: $('pending'),
  captureSection: $('capture-section'),
  captureList: $('capture-list'),
  captureEmpty: $('capture-empty'),
  captureLede: $('capture-lede'),
  captureSave: $('capture-save'),
  captureUndo: $('capture-undo'),
  captureDiscard: $('capture-discard'),
  firstRun: $('first-run'),
  projectLine: $('project-line'),
}

/** Bumped with the manifest. Shown in the panel so "am I running the new code?"
 *  is answerable by looking, not by guessing — we mistook a stale build for a
 *  dead backend twice. */
const PANEL_BUILD = '0.4.0'

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
  // Collapsed-by-default hid the one thing the user was looking for. Open it
  // whenever there is something in it, and leave it alone once they touch it.
  if (state.workflows.length && !els.workflowsDetails.dataset.touched) {
    els.workflowsDetails.open = true
  }
  if (state.workflows.length) {
    els.workflows.replaceChildren(...state.workflows.map(workflowRow))
  } else {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = 'Nothing recorded yet.'
    els.workflows.replaceChildren(li)
  }

  // Recorded, proposed, and waiting to be allowed to run. Nothing reaches
  // `active` without someone here saying so.
  const pending = state.workflows.filter((w) => w.status === 'draft')
  els.pendingSection.hidden = pending.length === 0
  els.pending.replaceChildren(...pending.map(pendingCard))

  // The empty state is the highest-leverage screen in the product, so it
  // teaches rather than reporting an absence.
  els.firstRun.hidden = state.workflows.length > 0 || !!recording
}

/** One workflow, with what it is matching on and a way to fix it. */
function workflowRow(w) {
  const li = document.createElement('li')
  li.className = 'wf'

  const head = document.createElement('div')
  head.className = 'wf-head'
  const name = document.createElement('span')
  name.className = 'wf-name'
  name.textContent = w.name
  head.append(name)

  // Health is a chip, not a sentence, because the question it answers at a
  // glance is "does anything need me".
  const state = w.health?.state ?? 'unknown'
  if (state !== 'ok') {
    const chip = document.createElement('span')
    chip.className = `chip chip-${state}`
    chip.textContent = state === 'unknown' ? 'not run yet' : state
    head.append(chip)
  }
  li.append(head)

  const meta = document.createElement('div')
  meta.className = 'wf-meta'
  meta.textContent = `produces ${w.produces} · ${w.steps} steps`
  li.append(meta)

  if (w.health && w.health.state !== 'ok' && w.health.state !== 'unknown') {
    const why = document.createElement('div')
    why.className = 'wf-health'
    why.textContent = w.health.summary
    li.append(why)

    // Only the steps that are actually decaying get a repair control. Listing
    // twenty healthy steps to reach the two that moved is not help.
    for (const step of w.health.degraded ?? []) {
      li.append(repairRow(w, step))
    }
  }
  return li
}

function repairRow(workflow, step) {
  const row = document.createElement('div')
  row.className = 'step-row'

  const label = document.createElement('span')
  label.className = 'step-note'
  label.textContent = step.note
  label.title = step.detail

  const fix = document.createElement('button')
  fix.className = 'ghost tiny'
  fix.textContent = 'Re-record'
  fix.title = 'Open the site, then do this one action again. Nothing else changes.'
  fix.onclick = async () => {
    fix.disabled = true
    const res = await worker({ t: 'panel.step.rerecord', workflowName: workflow.name, stepId: step.stepId })
    fix.disabled = false
    if (res?.error) return alert(res.error)
    await refresh()
  }

  row.append(label, fix)
  return row
}

/** A proposal, with what it will do, and the one button that lets it. */
function pendingCard(w) {
  const li = document.createElement('li')
  li.className = 'card'

  const title = document.createElement('div')
  title.className = 'card-title'
  title.textContent = w.name
  li.append(title)

  const sub = document.createElement('div')
  sub.className = 'card-sub'
  const inputs = (w.inputs ?? []).map((i) => i.name).join(', ')
  sub.textContent =
    `${w.steps} steps · produces ${w.produces}` + (inputs ? ` · takes ${inputs}` : '')
  li.append(sub)

  // What it will actually do, in order. This is the review — it happens here,
  // in the browser, at the moment the recording ends.
  const list = document.createElement('ol')
  list.className = 'steps'
  for (const step of w.stepList ?? []) {
    const item = document.createElement('li')
    item.textContent = step.note
    list.append(item)
  }
  li.append(list)

  const actions = document.createElement('div')
  actions.className = 'actions'

  const go = document.createElement('button')
  go.className = 'primary'
  go.textContent = 'Activate'
  go.onclick = async () => {
    go.disabled = true
    try {
      await daemon('/api/workflows.activate', { name: w.name })
    } catch (e) {
      alert(`Could not activate: ${e.message}`)
    } finally {
      await refresh()
    }
  }

  const drop = document.createElement('button')
  drop.className = 'ghost'
  drop.textContent = 'Delete'
  drop.onclick = async () => {
    drop.disabled = true
    try {
      await daemon('/api/workflows.delete', { name: w.name })
    } catch (e) {
      alert(`Could not delete: ${e.message}`)
    } finally {
      await refresh()
    }
  }

  actions.append(go, drop)
  li.append(actions)
  return li
}

/** What a captured action was, in the words the user would use. */
function describeAction(a) {
  const label = a.element?.label?.trim()
  const named = label ? `“${label.slice(0, 40)}”` : a.element?.tag || 'the page'
  switch (a.kind) {
    case 'navigate':
      return `Open ${a.value ?? 'the page'}`
    case 'click':
      return `Click ${named}`
    case 'type':
      return a.secret ? `Password in ${named} — not recorded` : `Type into ${named}`
    case 'key':
      return `Press ${a.value}`
    case 'wait':
      return a.wait?.kind === 'hidden' ? `Wait for ${named} to go` : `Wait for ${named}`
    case 'capture':
      return `Capture the ${a.capture?.as ?? 'result'}${a.resolvedByObserver ? ' (waited for it)' : ''}`
    default:
      return a.kind
  }
}

function renderRecording() {
  const on = !!recording
  els.record.classList.toggle('recording', on)
  els.recordLabel.textContent = on ? `Recording “${recording.name}”` : 'Record a workflow'
  els.record.disabled = on
  els.captureSection.hidden = !on
  if (on) els.recordDone.hidden = true
  if (!on) return

  // The whole list, not a count. A recorder that only says how many things it
  // heard cannot tell you it heard the wrong thing — which is exactly how a
  // recording comes back missing the step that mattered.
  const actions = recording.actions ?? []
  els.captureEmpty.hidden = actions.length > 0
  els.captureLede.hidden = !actions.some((a) => a.kind === 'type' && !a.secret)
  els.captureList.replaceChildren(
    ...actions.map((a) => {
      const li = document.createElement('li')
      if (a.kind === 'capture') li.className = 'is-capture'
      if (a.secret) li.className = 'is-secret'

      // A typed field is the one thing in a recording with a decision attached
      // to it, so it is the one thing that gets a control.
      if (a.kind !== 'type' || a.secret) {
        li.textContent = describeAction(a)
        return li
      }

      // Kept values read differently from the ones the agent will fill in, so
      // the list says which is which — but the choice itself is made in the
      // review, when the recording is saved, and only there.
      li.classList.add('has-role')
      const note = document.createElement('span')
      note.className = 'step-note'
      note.textContent = describeAction(a)
      note.title = a.value ?? ''
      li.append(note)
      if (a.role === 'fixed') {
        const kept = document.createElement('span')
        kept.className = 'role is-kept'
        kept.textContent = 'always this'
        li.append(kept)
      }
      return li
    }),
  )
  els.captureUndo.disabled = actions.length === 0
  // Saving a recording with nothing captured produces a workflow that cannot
  // run, so the control that would do it is not offered.
  els.captureSave.disabled = actions.length === 0
}

/* --------------------------------------------------------------- events */

els.record.onclick = async () => {
  if (recording) return
  els.nameInput.value = ''
  els.dialog.showModal()
  els.nameInput.focus()
}

els.captureSave.onclick = async () => {
  els.captureSave.disabled = true
  const res = await worker({ t: 'panel.record.stop' })
  if (res?.error) {
    els.captureSave.disabled = false
    return alert(`Could not save the recording: ${res.error}`)
  }
  const n = res?.actions ?? 0
  recording = null
  renderRecording()
  // Where it went, and whose move it is. It used to say "ask Claude Code to
  // review drafts", which was the product handing the user an errand in
  // another application.
  els.recordDone.textContent =
    `Saved ${n} action${n === 1 ? '' : 's'}. Atelier has written the workflow — check it above and activate it.`
  els.recordDone.hidden = false
  await refresh()
}

els.captureUndo.onclick = async () => {
  const res = await worker({ t: 'record.undo' })
  if (typeof res?.count === 'number' && recording) {
    recording.actions = (recording.actions ?? []).slice(0, res.count)
    renderRecording()
  }
}

els.captureDiscard.onclick = async () => {
  const n = recording?.actions?.length ?? 0
  if (n > 0 && !confirm(`Throw away ${n} recorded action${n === 1 ? '' : 's'}?`)) return
  await worker({ t: 'panel.record.discard' })
  recording = null
  renderRecording()
  await refresh()
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
  recording = { name, actions: [] }
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
    render({ jobs: o.jobs, workflows: o.workflows }, true, o.browsers)
    // Which project a recording will land in. The panel cannot switch it —
    // that is the dashboard's job — but staying silent about it means a
    // recording can be filed where nobody is looking with nothing on screen
    // having said so.
    if (o.activeProject) {
      els.projectLine.hidden = false
      els.projectLine.innerHTML =
        '<i></i><span>Recording into <b></b></span>'
      els.projectLine.querySelector('b').textContent = o.activeProject.name
    } else {
      els.projectLine.hidden = true
    }

    // The port is discovered, so the link cannot be a static href.
    els.dashboardLink.href = `http://127.0.0.1:${daemonPort}/`
    els.stamp.textContent =
      `panel ${PANEL_BUILD} · daemon ${o.version} on :${daemonPort} · ` +
      `${o.browsers.length} browser${o.browsers.length === 1 ? '' : 's'} attached`
  } catch (e) {
    daemonPort = null
    render({ jobs: [], workflows: [] }, false, [])
    els.stamp.textContent = `panel ${PANEL_BUILD} · daemon unreachable (${e.message})`
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
 * visible, and this is what stopped the panel looking frozen on changes made
 * while it was in the background.
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh()
})
window.addEventListener('focus', () => refresh())

// Once the human opens or closes the disclosure, stop deciding it for them.
els.workflowsDetails.addEventListener('toggle', () => {
  els.workflowsDetails.dataset.touched = '1'
})

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
  if (msg.t === 'panel.recording' && msg.recording) {
    recording = msg.recording
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
