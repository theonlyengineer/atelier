/**
 * The dashboard at http://127.0.0.1:7717 — the answer to "is it working, what
 * can it do, and does anything need me?"
 *
 * Deliberately not the same thing as the extension side panel. The panel is the
 * *action* surface: the one or two things that need a human, in the browser
 * where they would act. This is the *observation* surface.
 *
 * Which means it is scanned, not read. Two rules follow, and the first version
 * of this page broke both. **Aggregate, never enumerate** — eight rows reading
 * "generate-image · done · 2d ago" is a log wearing a summary's clothes; the
 * useful form is "14 runs, all succeeded". And **say a thing once** — the old
 * page reported a detached browser three times, in a stat, a banner and a
 * section, which teaches people to stop reading all three.
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
    --bg:#fcfcfb; --panel:#fff; --fg:#15161a; --dim:#5c6068; --faint:#8b9099;
    --line:#e7e7e3; --line-soft:#f0f0ec;
    --accent:#1f5fd0;
    --ok:#2d7d46; --ok-bg:#ecf6ef;
    --warn:#9a5c07; --warn-bg:#fbf1e2;
    --bad:#b3342a; --bad-bg:#fbeae8;
    --shadow:0 1px 2px rgb(20 22 26 / 5%);
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#0e1014; --panel:#161a20; --fg:#e9ecf1; --dim:#a2aab6; --faint:#6f7885;
      --line:#242a33; --line-soft:#1c2129;
      --accent:#6ba6ff;
      --ok:#5cb277; --ok-bg:#14251a;
      --warn:#d49a4a; --warn-bg:#2a2113;
      --bad:#e2695e; --bad-bg:#2c1817;
      --shadow:0 1px 2px rgb(0 0 0 / 40%);
    }
  }
  *{box-sizing:border-box}
  /* The hidden attribute is only the UA rule [hidden]{display:none}, which any
     author display rule outranks. This bit the side panel — keep it explicit. */
  [hidden]{display:none!important}
  body{margin:0;padding:0 20px 72px;background:var(--bg);color:var(--fg);
    font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:900px;margin:0 auto}
  h2{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--faint);
    font-weight:700;margin:0 0 10px}
  .mono{font-family:var(--mono)}
  code{font-family:var(--mono);font-size:.88em;background:var(--line-soft);padding:.1em .35em;
    border-radius:3px}
  button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);
    outline-offset:2px;border-radius:4px}

  /* ---- masthead: one status, said once ------------------------------- */
  .top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:22px 0 0}
  .mark{font-size:16px;font-weight:700;letter-spacing:-.01em;margin:0}
  .ver{font-family:var(--mono);font-size:11px;color:var(--faint)}
  /* The system's state as a single sentence. Six cards mostly reading zero is
     not a summary, it is decoration that has to be parsed. */
  .status{margin-left:auto;display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;
    padding:5px 12px;border-radius:99px;border:1px solid var(--line);background:var(--panel)}
  .status.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,transparent);background:var(--ok-bg)}
  .status.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 35%,transparent);background:var(--warn-bg)}
  .status.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent);background:var(--bad-bg)}
  .status i{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
  .status.ok i{animation:breathe 2.6s ease-in-out infinite}
  @keyframes breathe{0%,100%{opacity:1}50%{opacity:.35}}
  .facts{color:var(--faint);font-size:12px;font-family:var(--mono);margin:6px 0 0;
    display:flex;gap:14px;flex-wrap:wrap}

  /* ---- attention: only when true, and only once ---------------------- */
  .attn{display:flex;gap:12px;align-items:flex-start;padding:13px 15px;margin-top:18px;
    border:1px solid color-mix(in srgb,var(--bad) 35%,transparent);background:var(--bad-bg);
    border-radius:8px}
  .attn.warn{border-color:color-mix(in srgb,var(--warn) 35%,transparent);background:var(--warn-bg)}
  .attn .glyph{font-weight:700;color:var(--bad);line-height:1.4}
  .attn.warn .glyph{color:var(--warn)}
  .attn b{display:block;font-size:13px}
  .attn p{margin:3px 0 0;font-size:12.5px;color:var(--dim);line-height:1.5}
  .attn .act{margin-left:auto;display:flex;gap:6px;flex:none}

  /* ---- tabs ---------------------------------------------------------- */
  .tabs{display:flex;gap:0;margin:22px 0 18px;border-bottom:1px solid var(--line);flex-wrap:wrap}
  .tabs button{all:unset;cursor:pointer;padding:9px 15px;font-size:13px;color:var(--dim);
    border-bottom:2px solid transparent;margin-bottom:-1px;display:flex;align-items:center;gap:7px}
  .tabs button:hover{color:var(--fg)}
  .tabs button[aria-selected="true"]{color:var(--fg);border-bottom-color:var(--fg);font-weight:600}
  /* A badge means "this needs you", never "here is a count of things". Badge
     inflation is how people learn to ignore badges. */
  .badge{font-size:10px;font-weight:700;min-width:16px;text-align:center;padding:1px 5px;
    border-radius:9px;font-variant-numeric:tabular-nums}
  .badge.bad{background:var(--bad-bg);color:var(--bad)}
  .badge.go{background:var(--ok-bg);color:var(--ok)}

  /* ---- the workflow, which is the substance of the product ----------- */
  .wf{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:9px;
    padding:15px 17px 15px 20px;margin-bottom:10px;box-shadow:var(--shadow);overflow:hidden}
  /* State encoded in form as well as colour, so it survives a greyscale
     screenshot and a colour-blind reader. */
  .wf::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--line)}
  .wf.ok::before{background:var(--ok)}
  .wf.degraded::before{background:var(--warn)}
  .wf.fragile::before{background:var(--bad)}
  .wf.pending::before{background:var(--accent)}
  .wf-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .wf-name{font-family:var(--mono);font-size:14px;font-weight:600}
  .wf-produces{font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.07em;
    font-weight:600}
  .wf-actions{margin-left:auto;display:flex;gap:6px}
  .wf-desc{color:var(--dim);font-size:13px;margin:5px 0 0}
  .wf-meta{color:var(--faint);font-size:11.5px;font-family:var(--mono);margin-top:8px;
    display:flex;gap:9px;flex-wrap:wrap;align-items:center}
  /* Separators, because four facts set in one mono line with only whitespace
     between them read as a single string. */
  .wf-meta > * + *::before{content:"·";margin-right:9px;color:var(--line);font-weight:700}

  /* The run strip: the shape of a history, not a transcript of it. */
  .runs{display:flex;gap:2px;align-items:center}
  /* A wall of saturated green is a wall. Successes are the baseline and read
     quietly; a failure is the thing you are scanning for, so it keeps full
     strength and gets a little more room. */
  .runs i{width:4px;height:13px;border-radius:1.5px;background:var(--ok);opacity:.42}
  .runs i.bad{background:var(--bad);opacity:1;width:5px}
  .runs i.idle{background:var(--line)}

  .note{margin-top:10px;padding:9px 11px;border-radius:6px;font-size:12.5px;line-height:1.5}
  .note.warn{background:var(--warn-bg);color:var(--warn)}
  .note.bad{background:var(--bad-bg);color:var(--bad)}
  .note.info{background:var(--line-soft);color:var(--dim)}
  .note b{font-weight:600}

  .btn{all:unset;cursor:pointer;font-size:12px;padding:4px 11px;border-radius:6px;
    border:1px solid var(--line);color:var(--dim);background:var(--panel)}
  .btn:hover{color:var(--fg);border-color:var(--faint)}
  .btn.go{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,transparent);background:var(--ok-bg)}
  .btn.go:hover{filter:brightness(1.06)}
  .btn:disabled{opacity:.45;cursor:default}

  .steps{margin:9px 0 0;padding-left:20px;font-size:12px;line-height:1.65;color:var(--dim)}
  .steps summary{cursor:pointer;margin-left:-20px;list-style-position:inside;color:var(--faint);
    font-size:12px}

  /* ---- lists, assets, log -------------------------------------------- */
  .empty{border:1px dashed var(--line);border-radius:9px;padding:22px;color:var(--faint);
    font-size:13px;text-align:center;line-height:1.6}
  .empty b{display:block;color:var(--dim);font-size:13.5px;margin-bottom:5px;font-weight:600}
  .row{display:flex;align-items:center;gap:12px;padding:10px 2px;border-bottom:1px solid var(--line-soft);
    font-size:13px}
  .row:last-child{border-bottom:0}
  .row .k{font-family:var(--mono);font-size:12.5px}
  .row .when{margin-left:auto;color:var(--faint);font-size:12px;font-variant-numeric:tabular-nums}
  .pill{font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:5px;text-transform:uppercase;
    letter-spacing:.05em}
  .pill.ok{background:var(--ok-bg);color:var(--ok)}
  .pill.bad{background:var(--bad-bg);color:var(--bad)}
  .pill.idle{background:var(--line-soft);color:var(--faint)}
  .bar{height:3px;background:var(--line);border-radius:2px;overflow:hidden;margin-top:9px}
  .bar i{display:block;height:100%;background:var(--accent)}

  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:9px}
  .asset{margin:0;border:1px solid var(--line);border-radius:7px;overflow:hidden;background:var(--panel)}
  .asset img{width:100%;height:84px;object-fit:cover;display:block}
  .asset figcaption{font-size:10.5px;color:var(--faint);padding:6px 7px;font-family:var(--mono);
    line-height:1.4}

  .log{font-family:var(--mono);font-size:11.5px;line-height:1.65;background:var(--panel);
    border:1px solid var(--line);border-radius:8px;padding:13px 15px;overflow:auto;max-height:420px;
    white-space:pre-wrap;color:var(--dim);margin:0}
  .paths{color:var(--faint);font-size:11.5px;font-family:var(--mono);margin-top:14px;
    word-break:break-all;line-height:1.6}

  @media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1 class="mark">Atelier</h1>
    <span class="ver">v${version}</span>
    <span class="status" id="status"><i></i><span id="status-text">connecting</span></span>
  </div>
  <p class="facts" id="facts"></p>

  <!--
    Only rendered when something is actually waiting on a person, and said in
    exactly one place. The previous version reported a detached browser in a
    stat card, a banner and a section, which is how a reader learns that none of
    the three is worth reading.
  -->
  <div id="attention"></div>

  <nav class="tabs" id="tabs" role="tablist" aria-label="Sections">
    <button role="tab" id="tab-workflows" data-tab="workflows" aria-controls="panel-workflows">
      Workflows<span class="badge" id="badge-workflows" hidden></span>
    </button>
    <button role="tab" id="tab-runs" data-tab="runs" aria-controls="panel-runs">
      Runs<span class="badge" id="badge-runs" hidden></span>
    </button>
    <button role="tab" id="tab-assets" data-tab="assets" aria-controls="panel-assets">Assets</button>
    <button role="tab" id="tab-log" data-tab="log" aria-controls="panel-log">Log</button>
  </nav>

  <div role="tabpanel" id="panel-workflows" aria-labelledby="tab-workflows">
    <div id="workflows"></div>
  </div>

  <div role="tabpanel" id="panel-runs" aria-labelledby="tab-runs" hidden>
    <section id="active-sec" hidden>
      <h2>In flight</h2>
      <div id="active"></div>
    </section>
    <section>
      <h2>Recent</h2>
      <div id="recent"></div>
    </section>
  </div>

  <div role="tabpanel" id="panel-assets" aria-labelledby="tab-assets" hidden>
    <div id="assets" class="grid"></div>
    <div id="assets-empty"></div>
  </div>

  <div role="tabpanel" id="panel-log" aria-labelledby="tab-log" hidden>
    <pre class="log" id="log">…</pre>
    <p class="paths" id="paths"></p>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'))
const ago = (iso) => {
  if (!iso) return 'never'
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

const TABS = ['workflows', 'runs', 'assets', 'log']

/**
 * Which tab is showing lives here, not in render().
 *
 * render() runs on every state frame — every change, and every 25s regardless.
 * If the tab were derived from the data it would snap back under the reader
 * mid-sentence, which is the classic way a live page becomes unusable.
 */
let currentTab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'workflows'

function applyTab() {
  for (const t of TABS) {
    const tab = $('tab-' + t), panel = $('panel-' + t)
    if (!tab || !panel) continue
    const on = t === currentTab
    tab.setAttribute('aria-selected', on ? 'true' : 'false')
    tab.tabIndex = on ? 0 : -1
    panel.hidden = !on
  }
}

function goTab(t, opts) {
  if (!TABS.includes(t)) return
  currentTab = t
  if (location.hash.slice(1) !== t) history.replaceState(null, '', '#' + t)
  applyTab()
  if (opts && opts.focus) $('tab-' + t).focus()
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

/* -------------------------------------------------------------- pieces */

/** The run history as a shape: one mark per run, newest on the right. */
function runStrip(runs) {
  if (!runs || !runs.total) return '<span>never run</span>'
  const marks = (runs.recent || []).map(s =>
    '<i class="' + (s === 'done' ? '' : s === 'failed' || s === 'cancelled' ? 'bad' : 'idle') + '"></i>').join('')
  const summary = runs.failed === 0
    ? plural(runs.total, 'run') + ', all fine'
    : plural(runs.total, 'run') + ', ' + runs.failed + ' failed'
  return '<span class="runs" title="' + esc(summary) + '">' + marks + '</span>' +
    '<span>' + summary + '</span><span>' + ago(runs.lastAt) + '</span>'
}

function workflowCard(w) {
  const health = w.health || { state: 'unknown', summary: '', degraded: [] }
  const pending = w.status === 'draft'
  const tone = pending ? 'pending' : health.state === 'unknown' ? '' : health.state

  const actions = (pending
      ? '<button class="btn go" data-activate="' + esc(w.name) + '">Activate</button>'
      : '') +
    '<button class="btn" data-workflow="' + esc(w.name) + '">Delete</button>'

  const list = (w.stepList || []).map(s => '<li>' + esc(s.note) + '</li>').join('')
  const steps = !pending || !list ? ''
    : (w.stepList.length > 6
        ? '<details class="steps"><summary>' + plural(w.stepList.length, 'step') + '</summary><ol>' + list + '</ol></details>'
        : '<ol class="steps">' + list + '</ol>')

  // At most one note per card. Two stacked explanations is a paragraph, and
  // nobody reads a paragraph on a dashboard.
  let note = ''
  if (pending) {
    note = '<div class="note info">Recorded and written up. Nothing runs until you activate it.</div>'
  } else if (health.state === 'fragile' || health.state === 'degraded') {
    const worst = (health.degraded || [])[0]
    note = '<div class="note ' + (health.state === 'fragile' ? 'bad' : 'warn') + '">' +
      '<b>' + esc(health.summary) + '</b>' +
      (worst ? '<br>' + esc(worst.note) + ' — re-record that step from the side panel.' : '') +
      '</div>'
  }

  return '<article class="wf ' + tone + '">' +
    '<div class="wf-top">' +
      '<span class="wf-name">' + esc(w.name) + '</span>' +
      '<span class="wf-produces">' + esc(w.produces) + '</span>' +
      '<span class="wf-actions">' + actions + '</span>' +
    '</div>' +
    '<p class="wf-desc">' + esc(w.description) + '</p>' +
    '<div class="wf-meta">' +
      '<span>' + plural(w.steps, 'step') + '</span>' +
      '<span>' + esc((w.origins || []).join(', ')) + '</span>' +
      runStrip(w.runs) +
    '</div>' +
    note + steps +
    '</article>'
}

function jobCard(j) {
  const pct = j.stepCount ? (j.stepIndex / j.stepCount) * 100 : 0
  return '<article class="wf"><div class="wf-top">' +
    '<span class="wf-name">' + esc(j.workflowName) + '</span>' +
    '<span class="wf-produces">step ' + (j.stepIndex + 1) + ' of ' + j.stepCount + '</span></div>' +
    '<div class="bar"><i style="width:' + pct + '%"></i></div></article>'
}

/* -------------------------------------------------------------- render */

function render(d) {
  const blocked = d.jobs.filter(j => j.status === 'blocked')
  const active = d.jobs.filter(j => j.status === 'running' || j.status === 'queued')
  const attached = d.browsers.length > 0
  const decaying = (d.unhealthy || []).length
  const toActivate = (d.pendingActivation || []).length

  /* -- one status, said once ------------------------------------------ */
  const state = blocked.length ? 'bad' : !attached ? 'warn' : 'ok'
  const label = blocked.length
    ? plural(blocked.length, 'job') + ' waiting on you'
    : !attached ? 'No browser attached'
    : active.length ? plural(active.length, 'job') + ' running'
    : 'Ready'
  $('status').className = 'status ' + state
  $('status-text').textContent = label

  $('facts').innerHTML = [
    plural(d.counts.workflows, 'workflow'),
    plural(d.counts.assets, 'asset'),
    attached ? esc(d.browsers.map(b => b.label).join(', ')) : 'no browser',
    ':' + d.port + ' · up ' + dur(d.uptimeSeconds),
  ].map(x => '<span>' + x + '</span>').join('')

  /* -- attention: only what is true, and never twice ------------------- */
  const cards = []
  for (const j of blocked) {
    cards.push('<div class="attn"><span class="glyph">!</span><div>' +
      '<b>' + esc(j.workflowName) + ' is paused</b>' +
      '<p>' + esc(j.blockedReason || 'Paused.') + ' Resume it from the Atelier side panel.</p>' +
      '</div></div>')
  }
  if (!attached) {
    cards.push('<div class="attn warn"><span class="glyph">!</span><div>' +
      '<b>No browser attached</b>' +
      '<p>Load the extension from <code>atelier/extension/</code> at <code>chrome://extensions</code>, ' +
      'then open any tab. Workflows cannot run until one is.</p></div></div>')
  }
  $('attention').innerHTML = cards.join('')

  /* -- badges mean "needs you", not "count of things" ------------------ */
  setBadge('workflows', decaying + toActivate, decaying ? 'bad' : toActivate ? 'go' : '')
  setBadge('runs', active.length, active.length ? 'go' : '')

  /* -- workflows: the substance --------------------------------------- */
  $('workflows').innerHTML = d.workflows.length
    ? d.workflows.map(workflowCard).join('')
    : '<div class="empty"><b>Nothing recorded yet</b>' +
      'Open the site you want to automate, click the Atelier icon, and hit Record a workflow. ' +
      'It becomes a workflow when you save it, and appears here to activate.</div>'

  /* -- runs ------------------------------------------------------------ */
  $('active-sec').hidden = !active.length
  $('active').innerHTML = active.map(jobCard).join('')

  // Aggregated per workflow. Listing every run separately is how this page
  // ended up showing eight identical lines that told you nothing.
  const byWorkflow = d.workflows.filter(w => w.runs && w.runs.total)
  $('recent').innerHTML = byWorkflow.length
    ? byWorkflow.map(w =>
        '<div class="row"><span class="k">' + esc(w.name) + '</span>' +
        '<span class="pill ' + (w.runs.failed ? 'bad' : 'ok') + '">' +
        (w.runs.failed ? w.runs.failed + ' failed' : 'all fine') + '</span>' +
        '<span class="runs">' + (w.runs.recent || []).map(s =>
          '<i class="' + (s === 'done' ? '' : 'bad') + '"></i>').join('') + '</span>' +
        '<span class="when">' + plural(w.runs.total, 'run') + ' · ' + ago(w.runs.lastAt) + '</span></div>').join('')
    : '<div class="empty"><b>No runs yet</b>Ask your agent to run a workflow, or run one from the side panel.</div>'

  /* -- assets ---------------------------------------------------------- */
  $('assets').innerHTML = d.assets.map(a =>
    '<figure class="asset">' +
    (a.mime.startsWith('image/') ? '<img loading="lazy" src="/asset/' + a.id + '" alt="">' : '') +
    '<figcaption title="' + esc(a.prompt || '') + '">' +
    (a.width ? a.width + '×' + a.height : Math.round(a.bytes / 1024) + 'kB') + '<br>' +
    ago(a.createdAt) + '</figcaption></figure>').join('')
  $('assets-empty').innerHTML = d.assets.length ? ''
    : '<div class="empty"><b>Nothing produced yet</b>Assets a workflow captures land here, with the prompt that made them.</div>'

  /* -- log ------------------------------------------------------------- */
  $('log').textContent = d.log || '(empty)'
  $('paths').textContent = 'State in ' + d.home
}

/* ------------------------------------------------------------- actions */

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
  const activate = e.target.dataset && e.target.dataset.activate
  if (activate) {
    e.target.disabled = true
    try { await post('/api/workflows.activate', { name: activate }) }
    catch (err) { alert('Could not activate: ' + err.message); e.target.disabled = false }
    return
  }

  const wf = e.target.dataset && e.target.dataset.workflow
  if (!wf) return
  if (!confirm('Delete workflow “' + wf + '”? Assets it produced are kept.')) return
  e.target.disabled = true
  try { await post('/api/workflows.delete', { name: wf }) }
  catch (err) { alert('Could not delete: ' + err.message); e.target.disabled = false }
})

const source = new EventSource('/events')
source.onmessage = (e) => { render(JSON.parse(e.data)) }
source.onerror = () => {
  $('status').className = 'status bad'
  $('status-text').textContent = 'daemon unreachable'
}
</script>
</body>
</html>`
