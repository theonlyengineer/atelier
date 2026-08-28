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
  body{margin:0;padding:32px 24px 64px;background:var(--bg);color:var(--fg);
       font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:940px;margin:0 auto}
  header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:6px}
  h1{margin:0;font-size:19px;letter-spacing:-0.01em}
  .ver{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
  .sub{color:var(--muted);font-size:13px;margin:0 0 26px}

  /* The status strip is the whole point of the page: four numbers that say
     whether anything is wrong, readable from across the room. */
  .strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:28px}
  .stat{padding:13px 15px;border:1px solid var(--line);border-radius:11px;background:var(--card)}
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

  .empty{color:var(--muted);padding:13px 15px;border:1px dashed var(--line);border-radius:11px}
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

  <div class="strip" id="strip"></div>

  <section id="blocked-sec" hidden>
    <h2>Needs you</h2>
    <div id="blocked"></div>
  </section>

  <section id="active-sec" hidden>
    <h2>Running</h2>
    <div id="active"></div>
  </section>

  <section>
    <h2>Browsers</h2>
    <div id="browsers"></div>
  </section>

  <section>
    <h2>Workflows</h2>
    <div id="workflows"></div>
  </section>

  <section id="assets-sec">
    <h2>Recent assets</h2>
    <div id="assets" class="grid"></div>
  </section>

  <section>
    <h2>Recent jobs</h2>
    <div id="recent"></div>
  </section>

  <section>
    <h2>Log</h2>
    <pre class="log" id="log">…</pre>
  </section>

  <footer id="paths"></footer>
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

function render(d) {
  $('uptime').textContent = 'Listening on 127.0.0.1:' + d.port + ' · up ' + dur(d.uptimeSeconds)

  const blocked = d.jobs.filter(j => j.status === 'blocked')
  const active = d.jobs.filter(j => j.status === 'running' || j.status === 'queued')

  $('strip').innerHTML =
    '<div class="stat' + (blocked.length ? ' alert' : '') + '"><b>' + blocked.length + '</b><span>Needs you</span></div>' +
    '<div class="stat' + (active.length ? ' go' : '') + '"><b>' + active.length + '</b><span>Running</span></div>' +
    '<div class="stat' + (d.browsers.length ? ' go' : ' alert') + '"><b>' + d.browsers.length + '</b><span>Browsers</span></div>' +
    '<div class="stat"><b>' + d.counts.workflows + '</b><span>Workflows</span></div>'

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

  $('workflows').innerHTML = d.workflows.length
    ? d.workflows.map(w =>
        '<div class="card"><div class="row"><span class="name mono">' + esc(w.name) + '</span>' +
        '<span class="pill' + (w.status === 'active' ? ' on' : '') + '">' + esc(w.status) + '</span></div>' +
        '<div class="why">' + esc(w.description) + '</div>' +
        '<div class="why mono">' + w.steps + ' steps · produces ' + esc(w.produces) +
        ' · ' + esc(w.origins.join(', ')) + '</div></div>').join('')
    : '<div class="empty">' + (d.counts.drafts
        ? d.counts.drafts + ' recording(s) waiting for review. Ask Claude Code to check drafts.'
        : 'Nothing recorded yet. Click <b>Record a workflow</b> in the extension side panel.') + '</div>'

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

const source = new EventSource('/events')
source.onmessage = (e) => { render(JSON.parse(e.data)) }
source.onopen = () => { $('livedot').className = 'dot'; $('livetext').textContent = 'live' }
source.onerror = () => { $('livedot').className = 'dot dead'; $('livetext').textContent = 'reconnecting' }
</script>
</body>
</html>`
