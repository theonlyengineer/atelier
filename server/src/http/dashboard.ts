/**
 * The dashboard at http://127.0.0.1:7717 — the answer to "is it running, and
 * what is it doing?"
 *
 * Deliberately not the same thing as the extension side panel. The panel is the
 * *action* surface: the one or two things that need a human, in the browser
 * where they would act. This is the *observation* surface: everything, with
 * detail, for when something is wrong and you want to look at it.
 *
 * One self-contained file, no build step, no framework. It updates over
 * Server-Sent Events, so there is nothing to refresh and no polling.
 */

export const dashboardHtml = (version: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atelier</title>
<style>
  :root {
    --bg:#fbfbfa; --fg:#16161a; --muted:#6b6b76; --line:#e6e6e2; --card:#fff;
    --alert:#c0392b; --alert-bg:#fdf1ef; --go:#2d7d46; --go-bg:#eff7f1; --idle:#9a9aa4;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#131316; --fg:#f0f0ee; --muted:#9a9aa4; --line:#2a2a30; --card:#1b1b20;
           --alert:#f2555a; --alert-bg:#2a1618; --go:#4cae6a; --go-bg:#15251a; --idle:#6b6b76; }
  }
  *{box-sizing:border-box}
  /* The hidden attribute is only the UA rule [hidden]{display:none}, which any
     author display rule outranks. This bit the side panel — keep it explicit. */
  [hidden]{display:none!important}
  body{margin:0;padding:32px 24px 64px;background:var(--bg);color:var(--fg);
       font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:940px;margin:0 auto}
  header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:6px}
  h1{margin:0;font-size:19px;letter-spacing:-0.01em}
  .ver{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
  .sub{color:var(--muted);font-size:13px;margin:0 0 26px}

  /* The status strip is the whole point of the page: four numbers that say
     whether anything is wrong, readable from across the room. */
  /* Six stats, so auto-fit at minmax(150px) wraps 5+1 on a laptop and leaves one
     card stranded on its own row. Three across, then six, is a rhythm that
     divides cleanly at both widths. */
  .strip{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:6px}
  @media (min-width:720px){ .strip{grid-template-columns:repeat(6,1fr)} }
  .stat{all:unset;display:block;padding:13px 15px;border:1px solid var(--line);border-radius:11px;
    background:var(--card)}
  .stat:hover{border-color:var(--muted)}
  .stat b{display:block;font-size:23px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.15}
  .stat span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:600}
  .stat.alert{border-color:var(--alert);background:var(--alert-bg)}
  .stat.alert b{color:var(--alert)}
  .stat.go b{color:var(--go)}

  h2{margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:.09em;
     text-transform:uppercase;color:var(--muted)}
  section{margin-bottom:28px}

  .card{padding:13px 15px;border:1px solid var(--line);border-radius:11px;background:var(--card);margin-bottom:9px}
  .card.alert{border-color:var(--alert)}
  .row{display:flex;justify-content:space-between;align-items:baseline;gap:14px}
  .name{font-weight:600}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  .why{color:var(--muted);margin-top:4px}
  .why.bad{color:var(--alert)}
  .bar{height:3px;border-radius:3px;background:var(--line);overflow:hidden;margin-top:10px}
  .bar>i{display:block;height:100%;background:var(--go);transition:width .3s}

  .pill{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--line);
        color:var(--muted);white-space:nowrap}
  .pill.on{color:var(--go);border-color:var(--go);background:var(--go-bg)}
  .pill.off{color:var(--alert);border-color:var(--alert);background:var(--alert-bg)}
  /* Degrading, not yet broken: a state of its own, because folding it into
     "fine" is how a workflow surprises you and folding it into "broken" is how
     the warning gets ignored. */
  .pill.warn{color:#d99f45;border-color:#5a4a22;background:#2a2113}
  .go-btn{all:unset;cursor:pointer;font-size:11px;color:var(--go);padding:3px 9px;
    border:1px solid var(--go);border-radius:4px;background:var(--go-bg)}
  .go-btn:hover{filter:brightness(1.25)}
  .go-btn:disabled{opacity:.4;cursor:default}
  .steplist{margin:8px 0 0;padding-left:22px;font-size:11.5px;line-height:1.6;color:var(--muted)}
  .steplist summary{cursor:pointer;margin-left:-22px;list-style-position:inside}

  /* Tabs. Underline rather than boxes: the panel below is the content, and a
     boxed tab draws a second container around something already contained. */
  .tabs{display:flex;gap:2px;margin:22px 0 4px;border-bottom:1px solid var(--line);
        flex-wrap:wrap}
  .tabs button{all:unset;cursor:pointer;padding:9px 14px;font-size:13px;color:var(--muted);
    border-bottom:2px solid transparent;margin-bottom:-1px;display:flex;align-items:center;gap:7px}
  .tabs button:hover{color:var(--fg)}
  .tabs button[aria-selected="true"]{color:var(--fg);border-bottom-color:var(--fg);font-weight:600}
  .tabs button:focus-visible{outline:2px solid var(--go);outline-offset:-2px;border-radius:3px}
  /* A count on the tab, so you can see there is something to deal with without
     opening it — which is the only thing that makes hiding it acceptable. */
  .badge{font-size:10px;font-weight:700;min-width:17px;text-align:center;padding:1px 5px;
    border-radius:9px;background:var(--line);color:var(--muted);font-variant-numeric:tabular-nums}
  .badge.alert{background:var(--alert-bg);color:var(--alert)}
  .badge.go{background:var(--go-bg);color:var(--go)}
  #attention section{margin-top:18px}
  .alert-h{color:var(--alert)}
  .stat{cursor:pointer}
  .stat:focus-visible{outline:2px solid var(--go);outline-offset:2px}

  .empty{color:var(--muted);padding:13px 15px;border:1px dashed var(--line);border-radius:11px}
  .del{all:unset;cursor:pointer;font-size:11px;color:var(--muted);padding:3px 9px;
       border:1px solid var(--line);border-radius:999px;white-space:nowrap}
  .del:hover{color:var(--alert);border-color:var(--alert);background:var(--alert-bg)}
  .draft{border-color:var(--go)}
  .draft .pill{color:var(--go);border-color:var(--go);background:var(--go-bg)}
  .head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:10px}
  .head h2{margin:0}
  .empty code{font-family:ui-monospace,Menlo,monospace;font-size:12px}

  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
  .asset{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--card)}
  .asset img{display:block;width:100%;height:104px;object-fit:cover;background:var(--bg)}
  .asset figcaption{padding:7px 9px;font-size:11px;color:var(--muted);
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

  table{width:100%;border-collapse:collapse;font-size:13px}
  td{padding:7px 0;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:0}
  td.k{color:var(--muted);width:38%}

  pre.log{margin:0;padding:13px 15px;border:1px solid var(--line);border-radius:11px;
      background:var(--card);font-family:ui-monospace,Menlo,monospace;font-size:11.5px;
      line-height:1.65;max-height:230px;overflow:auto;color:var(--muted);white-space:pre-wrap}
  footer{margin-top:34px;color:var(--muted);font-size:12px}
  .live{display:inline-flex;align-items:center;gap:6px}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--go)}
  .dot.dead{background:var(--alert)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Atelier</h1>
    <span class="ver">v${version}</span>
    <span class="live"><i class="dot" id="livedot"></i><span class="ver" id="livetext">live</span></span>
  </header>
  <p class="sub" id="uptime">&nbsp;</p>

  <!-- The strip is navigation as well as a readout: each number is the reason
       you would open the tab it belongs to. -->
  <div class="strip" id="strip"></div>

  <!--
    Everything above and inside this band stays put on every tab.

    Splitting the page into tabs is only an improvement if it never hides the
    thing you came to find. A parked job and a browser that is not attached are
    the two states where Atelier is stuck waiting on a person, so they are the
    two that must never be one click away.
  -->
  <div id="attention">
    <section id="blocked-sec" hidden>
      <h2 class="alert-h">Needs you</h2>
      <div id="blocked"></div>
    </section>
    <section id="detached-sec" hidden>
      <div class="card alert">
        <div class="row"><span class="name">No browser attached</span></div>
        <div class="why">Load the extension from <code>atelier/extension/</code> at
          <code>chrome://extensions</code>, then open any tab. Workflows cannot run until one is.</div>
      </div>
    </section>
  </div>

  <nav class="tabs" id="tabs" role="tablist" aria-label="Sections">
    <button role="tab" id="tab-activity" data-tab="activity" aria-controls="panel-activity">
      Activity<span class="badge" id="badge-activity" hidden></span>
    </button>
    <button role="tab" id="tab-workflows" data-tab="workflows" aria-controls="panel-workflows">
      Workflows<span class="badge" id="badge-workflows" hidden></span>
    </button>
    <button role="tab" id="tab-assets" data-tab="assets" aria-controls="panel-assets">
      Assets<span class="badge" id="badge-assets" hidden></span>
    </button>
    <button role="tab" id="tab-diagnostics" data-tab="diagnostics" aria-controls="panel-diagnostics">
      Diagnostics
    </button>
  </nav>

  <div role="tabpanel" id="panel-activity" aria-labelledby="tab-activity">
    <section id="active-sec" hidden>
      <h2>Running</h2>
      <div id="active"></div>
    </section>
    <section>
      <h2>Recent jobs</h2>
      <div id="recent"></div>
    </section>
    <section>
      <h2>Browsers</h2>
      <div id="browsers"></div>
    </section>
  </div>

  <div role="tabpanel" id="panel-workflows" aria-labelledby="tab-workflows" hidden>
    <section>
      <h2>Workflows</h2>
      <div id="workflows"></div>
    </section>
    <section id="drafts-sec" hidden>
      <h2>Recordings</h2>
      <div id="drafts"></div>
    </section>
  </div>

  <div role="tabpanel" id="panel-assets" aria-labelledby="tab-assets" hidden>
    <section id="assets-sec">
      <h2>Recent assets</h2>
      <div id="assets" class="grid"></div>
    </section>
  </div>

  <div role="tabpanel" id="panel-diagnostics" aria-labelledby="tab-diagnostics" hidden>
    <section>
      <h2>Log</h2>
      <pre class="log" id="log">…</pre>
    </section>
    <footer id="paths"></footer>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return Math.round(s) + 's ago'
  if (s < 3600) return Math.round(s / 60) + 'm ago'
  if (s < 86400) return Math.round(s / 3600) + 'h ago'
  return Math.round(s / 86400) + 'd ago'
}
const dur = (sec) => {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60)
  return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m ? m + 'm' : Math.floor(sec) + 's'
}

/* ------------------------------------------------------------------ tabs */

const TABS = ['activity', 'workflows', 'assets', 'diagnostics']

/**
 * Which tab is showing lives here, not in render().
 *
 * render() runs on every state frame — every change, and every 25s regardless.
 * If the tab were derived from the data it would snap back under the reader
 * mid-sentence, which is the classic way a live-updating page becomes unusable.
 */
let currentTab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'activity'

function applyTab() {
  for (const t of TABS) {
    const tab = $('tab-' + t)
    const panel = $('panel-' + t)
    if (!tab || !panel) continue
    const on = t === currentTab
    tab.setAttribute('aria-selected', on ? 'true' : 'false')
    tab.tabIndex = on ? 0 : -1
    panel.hidden = !on
  }
}

function goTab(t, { focus = false } = {}) {
  if (!TABS.includes(t)) return
  currentTab = t
  // In the hash so a refresh keeps you where you were, and so a link to a
  // particular view is a link.
  if (location.hash.slice(1) !== t) history.replaceState(null, '', '#' + t)
  applyTab()
  if (focus) $('tab-' + t).focus()
}

function setBadge(tab, n, tone) {
  const el = $('badge-' + tab)
  if (!el) return
  el.hidden = !n
  el.textContent = String(n)
  el.className = 'badge' + (tone ? ' ' + tone : '')
}

$('tabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]')
  if (t) goTab(t.dataset.tab)
})

// Arrow keys across a tablist are the expected behaviour, and cheap.
$('tabs').addEventListener('keydown', (e) => {
  const i = TABS.indexOf(currentTab)
  if (e.key === 'ArrowRight') goTab(TABS[(i + 1) % TABS.length], { focus: true })
  else if (e.key === 'ArrowLeft') goTab(TABS[(i - 1 + TABS.length) % TABS.length], { focus: true })
  else if (e.key === 'Home') goTab(TABS[0], { focus: true })
  else if (e.key === 'End') goTab(TABS[TABS.length - 1], { focus: true })
  else return
  e.preventDefault()
})

window.addEventListener('hashchange', () => {
  const t = location.hash.slice(1)
  if (TABS.includes(t)) { currentTab = t; applyTab() }
})

applyTab()

function jobCard(j, alert) {
  const pct = j.stepCount ? (j.stepIndex / j.stepCount) * 100 : 0
  return '<div class="card' + (alert ? ' alert' : '') + '">' +
    '<div class="row"><span class="name">' + esc(j.workflowName) + '</span>' +
    '<span class="pill">step ' + (j.stepIndex + 1) + ' of ' + j.stepCount + '</span></div>' +
    (alert
      ? '<div class="why bad">' + esc(j.blockedReason || 'Paused.') + '</div>' +
        '<div class="why">Resume it from the Atelier side panel in your browser.</div>'
      : '<div class="bar"><i style="width:' + pct + '%"></i></div>') +
    '</div>'
}

/** A workflow, with what it is matching on now. Replay falls back through its
 *  selector candidates silently, so a step quietly matching on position looks
 *  identical to a healthy one — this is the only place that difference shows. */
function workflowCard(w) {
  const health = w.health || { state: 'unknown', summary: '', degraded: [] }
  const pending = w.status === 'draft'

  const chip = health.state === 'ok'
    ? '<span class="pill on">healthy</span>'
    : health.state === 'unknown'
      ? '<span class="pill">not run yet</span>'
      : '<span class="pill ' + (health.state === 'fragile' ? 'off' : 'warn') + '">' + esc(health.state) + '</span>'

  const controls = (pending
      ? '<button class="go-btn" data-activate="' + esc(w.name) + '">Activate</button> '
      : '') +
    '<button class="del" data-workflow="' + esc(w.name) + '">Delete</button>'

  const degraded = (health.degraded || []).map(s =>
    '<div class="why bad">' + esc(s.note) + ' — ' + esc(s.detail) + '</div>').join('')

  // The steps are the review, so they are shown — but a twenty-step proposal
  // should not push everything else off the screen to say so.
  const list = (w.stepList || []).map(s => '<li>' + esc(s.note) + '</li>').join('')
  const steps = !pending || !list
    ? ''
    : (w.stepList.length > 6
        ? '<details class="steplist"><summary>' + w.stepList.length + ' steps</summary><ol>' + list + '</ol></details>'
        : '<ol class="steplist">' + list + '</ol>')

  return '<div class="card' + (health.state === 'fragile' ? ' alert' : '') + '">' +
    '<div class="row"><span class="name mono">' + esc(w.name) + '</span>' +
    '<span><span class="pill' + (w.status === 'active' ? ' on' : '') + '">' + esc(w.status) + '</span> ' +
    chip + ' ' + controls + '</span></div>' +
    '<div class="why">' + esc(w.description) + '</div>' +
    '<div class="why mono">' + w.steps + ' steps · produces ' + esc(w.produces) +
    ' · ' + esc(w.origins.join(', ')) + '</div>' +
    (health.state !== 'ok' && health.state !== 'unknown'
      ? '<div class="why">' + esc(health.summary) + '</div>' + degraded +
        '<div class="why">Re-record the affected step from the Atelier side panel.</div>'
      : '') +
    (pending ? '<div class="why">Recorded and written up. Nothing runs until you activate it.</div>' + steps : '') +
    '</div>'
}

function render(d) {
  $('uptime').textContent = 'Listening on 127.0.0.1:' + d.port + ' · up ' + dur(d.uptimeSeconds)

  const blocked = d.jobs.filter(j => j.status === 'blocked')
  const active = d.jobs.filter(j => j.status === 'running' || j.status === 'queued')

  const decaying = (d.unhealthy || []).length
  const toActivate = (d.pendingActivation || []).length

  // Each stat is a link to the tab you would act on it in — which is what keeps
  // the split navigable rather than a place things went missing.
  const stat = (n, label, tab, tone) =>
    '<button class="stat' + (tone ? ' ' + tone : '') + '" data-goto="' + tab + '">' +
    '<b>' + n + '</b><span>' + label + '</span></button>'

  $('strip').innerHTML =
    stat(blocked.length, 'Needs you', 'activity', blocked.length ? 'alert' : '') +
    stat(active.length, 'Running', 'activity', active.length ? 'go' : '') +
    stat(d.browsers.length, 'Browsers', 'activity', d.browsers.length ? 'go' : 'alert') +
    stat(d.counts.workflows, 'Workflows', 'workflows', '') +
    stat(decaying, 'Decaying', 'workflows', decaying ? 'alert' : '') +
    stat(toActivate, 'To activate', 'workflows', toActivate ? 'go' : '')

  // A browser that is not attached is the other state where Atelier is stuck
  // waiting on a person, so it sits with the parked jobs rather than three
  // sections down under "Browsers".
  $('detached-sec').hidden = d.browsers.length > 0

  setBadge('activity', active.length, active.length ? 'go' : '')
  setBadge('workflows', decaying + toActivate, decaying ? 'alert' : toActivate ? 'go' : '')
  setBadge('assets', d.assets.length, '')

  $('blocked-sec').hidden = !blocked.length
  $('blocked').innerHTML = blocked.map(j => jobCard(j, true)).join('')
  $('active-sec').hidden = !active.length
  $('active').innerHTML = active.map(j => jobCard(j, false)).join('')

  $('browsers').innerHTML = d.browsers.length
    ? d.browsers.map(b =>
        '<div class="card"><div class="row"><span class="name">' + esc(b.label) + '</span>' +
        '<span class="pill on">connected</span></div>' +
        '<div class="why mono">' + esc(b.profileId.slice(0, 8)) + ' · ' + esc(b.browser) + '</div></div>').join('')
    : '<div class="empty">No browser connected. Load the extension from <code>atelier/extension/</code> at <code>chrome://extensions</code>, then open any tab.</div>'

  const drafts = d.drafts || []
  $('drafts-sec').hidden = !drafts.length
  $('drafts').innerHTML = drafts.map(x =>
    '<div class="card draft"><div class="row"><span class="name mono">' + esc(x.name) + '</span>' +
    '<span><span class="pill">' + x.actions + ' actions</span> ' +
    '<button class="del" data-draft="' + esc(x.id) + '">Delete</button></span></div>' +
    '<div class="why">Recorded ' + ago(x.createdAt) + ' on ' + esc((x.origins || []).join(', ')) +
    '. Kept as the record of what was captured — the workflow it produced is below.</div></div>').join('')

  $('workflows').innerHTML = d.workflows.length
    ? d.workflows.map(workflowCard).join('')
    : '<div class="empty">No workflows yet. Record one from the Atelier side panel — it becomes a workflow when you save it, and appears here to activate.</div>'

  $('assets-sec').hidden = !d.assets.length
  $('assets').innerHTML = d.assets.map(a =>
    '<figure class="asset" style="margin:0">' +
    (a.mime.startsWith('image/') ? '<img loading="lazy" src="/asset/' + a.id + '" alt="">' : '') +
    '<figcaption title="' + esc(a.prompt || '') + '">' +
    (a.width ? a.width + '×' + a.height + ' · ' : '') + Math.round(a.bytes / 1024) + 'kB<br>' +
    ago(a.createdAt) + '</figcaption></figure>').join('')

  $('recent').innerHTML = d.recent.length
    ? '<div class="card"><table>' + d.recent.map(j =>
        '<tr><td class="k">' + esc(j.workflowName) + '</td>' +
        '<td><span class="pill' + (j.status === 'done' ? ' on' : j.status === 'failed' ? ' off' : '') + '">' +
        esc(j.status) + '</span> ' + ago(j.updatedAt) +
        (j.error ? '<div class="why bad">' + esc(j.error) + '</div>' : '') + '</td></tr>').join('') +
      '</table></div>'
    : '<div class="empty">No jobs yet.</div>'

  $('log').textContent = d.log || '(empty)'
  $('paths').innerHTML = 'State in <span class="mono">' + esc(d.home) + '</span> · ' +
    d.counts.assets + ' assets · ' + d.counts.jobs + ' jobs'
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await res.json()
  if (payload.ok === false) throw new Error(payload.error)
  return payload.result
}

// Delegated, because the cards are re-rendered on every state frame.
document.addEventListener('click', async (e) => {
  const goto = e.target.closest?.('[data-goto]')
  if (goto) return goTab(goto.dataset.goto)

  const activate = e.target.dataset?.activate
  if (activate) {
    e.target.disabled = true
    try {
      await post('/api/workflows.activate', { name: activate })
    } catch (err) {
      alert('Could not activate: ' + err.message)
      e.target.disabled = false
    }
    return
  }

  const wf = e.target.dataset?.workflow
  const dr = e.target.dataset?.draft
  if (!wf && !dr) return
  const what = wf ? 'workflow “' + wf + '”' : 'this recording'
  if (!confirm('Delete ' + what + '? Assets it produced are kept.')) return
  e.target.disabled = true
  try {
    if (wf) await post('/api/workflows.delete', { name: wf })
    else await post('/api/drafts.delete', { id: dr })
  } catch (err) {
    alert('Could not delete: ' + err.message)
    e.target.disabled = false
  }
})

const source = new EventSource('/events')
source.onmessage = (e) => { render(JSON.parse(e.data)) }
source.onopen = () => { $('livedot').className = 'dot'; $('livetext').textContent = 'live' }
source.onerror = () => { $('livedot').className = 'dot dead'; $('livetext').textContent = 'reconnecting' }
</script>
</body>
</html>`
