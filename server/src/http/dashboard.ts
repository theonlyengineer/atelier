/**
 * The dashboard at http://127.0.0.1:7717 — the answer to "is it working, what
 * can it do, and does anything need me?"
 *
 * Deliberately not the same thing as the extension side panel. The panel is the
 * *action* surface: the one or two things that need a human, in the browser
 * where they would act. This is the *observation* surface.
 *
 * It is scanned, not read, and three rules follow. **Aggregate, never
 * enumerate** — fifteen rows reading "done · 2d ago" is a log wearing a
 * summary's clothes. **Say a thing once** — an earlier version reported a
 * detached browser in a stat, a banner and a section, which teaches a reader
 * that none of the three is worth reading. And **the overview shows a little of
 * everything**, so the first screen answers the question rather than asking
 * which tab you want.
 *
 * One self-contained file: no build step, no framework, no external requests.
 * The charts are hand-drawn SVG for the same reason — a dashboard that cannot
 * render without reaching the network is a dashboard that fails exactly when
 * you need it. It updates over Server-Sent Events, so there is nothing to
 * refresh and no polling.
 */

export const dashboardHtml = (version: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atelier</title>
<!--
  The two house faces. Deliberately the only thing on this page that reaches the
  network, and it is a real trade: the daemon's whole posture is that nothing
  leaves the machine, and a font request tells Google you opened your dashboard.
  It is here because typography is half of a visual identity and the fallbacks
  are not close. It degrades to the system stack in one hop if the request
  fails, so an offline dashboard still renders correctly — just not in the house
  faces. Delete these two lines to make the page wholly self-contained.
-->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" media="print" onload="this.media='all'"
  href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,600;8..60,700&display=swap">
<noscript><link rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,600;8..60,700&display=swap"></noscript>
<style>
  /*
   * The house palette, taken from the public site so the tool and the thing it
   * serves look like one hand: warm paper, hard black rules, and exactly one
   * accent. Vermilion is the whole colour budget — which is why success here is
   * *ink*, not green. A run that worked is unremarkable; a run that failed is
   * the only thing worth spending the accent on.
   */
  :root{
    --page:#FFFBF5;        /* warm paper — the house ground */
    --panel:#FFFFFF;
    --sunk:#F8F4EC;        /* the house secondary surface */
    --ink:#000000;
    --dim:rgb(0 0 0/68%);
    --faint:rgb(0 0 0/46%);
    --line:rgb(0 0 0/14%);
    --line-2:rgb(0 0 0/8%);
    --accent:#FE402E;
    --accent-soft:#FFEBE7;
    --ok:#1A1A1A;           /* success is ink: it is the baseline, not an event */
    --ok-soft:#F1EFEA;
    --warn:#9A6410;
    --warn-soft:#FBF0DE;
    --bad:#FE402E;
    --bad-soft:#FFEBE7;
    --k1:#F8F4EC;           /* three tones of the same paper, not three */
    --k1-ink:#1A1A1A;       /* unrelated pastels */
    --k2:#FFEBE7;
    --k2-ink:#B32414;
    --k3:#111111;
    --k3-ink:#FFFBF5;
    --r:10px; --r-sm:7px;
    --serif:"Source Serif 4",ui-serif,Georgia,"Times New Roman",serif;
    --sans:"Poppins",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  /*
   * Light only, on purpose. The house style has no dark mode, and inventing one
   * means the dashboard stops matching the thing it is meant to match for
   * everyone whose OS is set to dark — which is most people, which is how this
   * shipped looking nothing like its own reference. If a dark variant is ever
   * wanted it is a decision to take deliberately, not a default to assume.
   */
  :root{color-scheme:light}
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  html,body{height:100%}
  body{margin:0;background:var(--page);color:var(--ink);
    font:14px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
  h1,h2,h3,.brand b,.kpi .big{font-family:var(--serif)}
  button{font:inherit}
  ::selection{background:var(--accent-soft)}
  .mono{font-family:var(--mono)}
  code{font-family:var(--mono);font-size:.86em;background:var(--sunk);padding:.12em .38em;border-radius:5px}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}

  /* ---------------------------------------------------------- shell --- */
  .app{display:grid;grid-template-columns:236px 1fr;min-height:100vh}
  @media (max-width:820px){ .app{grid-template-columns:1fr} }

  .side{background:var(--panel);border-right:1px solid var(--line);padding:22px 16px;
    display:flex;flex-direction:column;gap:22px;position:sticky;top:0;height:100vh}
  @media (max-width:820px){ .side{position:static;height:auto} }
  .brand{display:flex;align-items:center;gap:10px;padding:0 8px}
  .brand .glyph{width:26px;height:26px;border-radius:7px;background:var(--accent);color:#fff;
    display:grid;place-items:center;font-weight:800;font-size:13px;flex:none}
  .brand b{font-size:15.5px;letter-spacing:-.01em}
  .brand span{font-family:var(--mono);font-size:10px;color:var(--faint)}

  .navlabel{font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;
    color:var(--faint);padding:0 8px;margin-bottom:-10px}
  .nav{display:flex;flex-direction:column;gap:2px}
  .nav button{all:unset;cursor:pointer;display:flex;align-items:center;gap:11px;padding:9px 10px;
    border-radius:10px;color:var(--dim);font-size:13.5px}
  .nav button:hover{background:var(--sunk);color:var(--ink)}
  .nav button[aria-selected="true"]{background:var(--ink);color:var(--page);font-weight:600}
  .nav svg{width:17px;height:17px;flex:none;stroke:currentColor;fill:none;stroke-width:1.7;
    stroke-linecap:round;stroke-linejoin:round}
  .nav .badge{margin-left:auto;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;
    background:var(--bad-soft);color:var(--bad);font-variant-numeric:tabular-nums}
  .nav button[aria-selected="true"] .badge{background:var(--panel);color:var(--ink)}

  /* The health of the thing itself, parked at the bottom of the nav where a
     product would put the account — because "is it even connected" is the
     ambient question, not a section you navigate to. */
  .sidestat{margin-top:auto;background:var(--sunk);border-radius:var(--r-sm);padding:13px 14px}
  .sidestat .dotline{display:flex;align-items:center;gap:8px;font-weight:600;font-size:12.5px}
  .sidestat i{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
  .sidestat.ok .dotline{color:var(--ink)} .sidestat.warn .dotline{color:var(--warn)}
  .sidestat.bad .dotline{color:var(--bad)}
  .sidestat.ok i{animation:breathe 2.8s ease-in-out infinite}
  @keyframes breathe{0%,100%{opacity:1}50%{opacity:.3}}
  .sidestat p{margin:7px 0 0;font-size:11px;color:var(--faint);font-family:var(--mono);line-height:1.6;
    white-space:pre-line;word-break:break-word}

  /* ----------------------------------------------------------- main --- */
  .main{padding:24px 28px 64px;min-width:0}
  @media (max-width:560px){ .main{padding:18px 16px 48px} }
  .head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:22px}
  .head h1{margin:0;font-size:27px;font-weight:700;letter-spacing:-.02em;line-height:1.1}
  .head p{margin:3px 0 0;color:var(--faint);font-size:13px}
  .live{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dim);
    background:var(--panel);border:1px solid var(--line);padding:6px 12px;border-radius:99px}
  .live i{width:6px;height:6px;border-radius:50%;background:var(--ink)}
  .live.dead i{background:var(--bad)}

  section{margin-bottom:22px}
  .sec-head{display:flex;align-items:center;gap:10px;margin-bottom:11px}
  .sec-head h2{margin:0;font-size:12px;font-weight:700;text-transform:uppercase;
    letter-spacing:.2em;font-family:var(--sans);color:var(--faint)}
  .sec-head .more{margin-left:auto}

  /* A surface is drawn with a rule, not a shadow — the house way. */
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r)}
  .pad{padding:18px 20px}

  /* ------------------------------------------------------------ kpi --- */
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(232px,1fr));gap:14px}
  .kpi{border-radius:var(--r);padding:18px 20px 16px;display:flex;flex-direction:column;gap:2px;
    position:relative;overflow:hidden}
  .kpi.k1{background:var(--k1);color:var(--k1-ink)}
  .kpi.k2{background:var(--k2);color:var(--k2-ink)}
  .kpi.k3{background:var(--k3);color:var(--k3-ink)}
  .kpi .top{display:flex;align-items:center;gap:9px;font-weight:650;font-size:13px}
  .kpi .top svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.8;
    stroke-linecap:round;stroke-linejoin:round}
  .kpi .big{font-size:38px;font-weight:700;letter-spacing:-.03em;line-height:1.1;margin-top:10px;
    font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:9px}
  .kpi .chip{font-size:11px;font-weight:700;padding:3px 9px;border-radius:99px;
    background:rgb(0 0 0/8%);font-family:var(--sans)}
  .kpi.k3 .chip{background:rgb(255 255 255/14%)}
  .kpi .sub{font-size:12px;opacity:.78;margin-top:2px}
  .kpi .go{all:unset;cursor:pointer;margin-top:14px;align-self:flex-start;font-size:12px;
    font-weight:600;background:rgb(255 255 255/80%);padding:7px 14px;border-radius:99px;
    display:flex;align-items:center;gap:6px;color:inherit}
  .kpi.k3 .go{background:rgb(255 255 255/13%)}
  .kpi .go:hover{filter:brightness(1.05)}

  /* ---------------------------------------------------------- charts --- */
  .split{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:14px}
  @media (max-width:900px){ .split{grid-template-columns:1fr} }
  .chart-legend{display:flex;gap:14px;font-size:11.5px;color:var(--faint);margin-left:auto}
  .chart-legend span{display:flex;align-items:center;gap:6px}
  .chart-legend i{width:8px;height:8px;border-radius:3px}
  .donut-wrap{display:flex;flex-direction:column;align-items:center;gap:12px}
  .donut-legend{display:flex;flex-direction:column;gap:7px;width:100%;font-size:12px}
  .donut-legend div{display:flex;align-items:center;gap:8px;color:var(--dim)}
  .donut-legend i{width:9px;height:9px;border-radius:3px;flex:none}
  .donut-legend b{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--ink)}

  /* ------------------------------------------------------- workflows --- */
  .wf{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);
    padding:17px 20px 17px 22px;margin-bottom:12px;overflow:hidden}
  /* State in form as well as colour, so it survives greyscale and colour-blindness. */
  .wf::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--line)}
  .wf.ok::before{background:var(--ok)} .wf.degraded::before{background:var(--warn)}
  .wf.fragile::before{background:var(--bad)} .wf.pending::before{background:var(--accent)}
  .wf-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .wf-name{font-family:var(--mono);font-size:14px;font-weight:600}
  .tag{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
    padding:3px 8px;border-radius:7px;background:var(--sunk);color:var(--faint)}
  .tag.ok{background:var(--ok-soft);color:var(--ok)} .tag.warn{background:var(--warn-soft);color:var(--warn)}
  .tag.bad{background:var(--bad-soft);color:var(--bad)} .tag.go{background:var(--accent-soft);color:var(--accent)}
  .wf-actions{margin-left:auto;display:flex;gap:7px}
  .wf-desc{color:var(--dim);font-size:13px;margin:7px 0 0}
  .wf-meta{color:var(--faint);font-size:11.5px;font-family:var(--mono);margin-top:10px;
    display:flex;gap:9px;flex-wrap:wrap;align-items:center}
  .wf-meta > * + *::before{content:"·";margin-right:9px;color:var(--line);font-weight:700}
  .runs{display:flex;gap:2px;align-items:center}
  /* Successes are the baseline and read quietly; a failure is what you are
     scanning for, so it keeps full strength and a little more room. */
  .runs i{width:4px;height:13px;border-radius:2px;background:var(--ok);opacity:.38}
  .runs i.bad{background:var(--bad);opacity:1;width:5px}
  .note{margin-top:11px;padding:10px 12px;border-radius:10px;font-size:12.5px;line-height:1.55}
  .note.warn{background:var(--warn-soft);color:var(--warn)}
  .note.bad{background:var(--bad-soft);color:var(--bad)}
  .note.info{background:var(--sunk);color:var(--dim)}
  .steps{margin:10px 0 0;padding-left:20px;font-size:12px;line-height:1.7;color:var(--dim)}
  .steps summary{cursor:pointer;margin-left:-20px;list-style-position:inside;color:var(--faint)}

  /* ---------------------------------------------------------- bits ---- */
  .btn{all:unset;cursor:pointer;font-size:12px;font-weight:550;padding:6px 13px;border-radius:9px;
    border:1px solid var(--line);color:var(--dim);background:var(--panel)}
  .btn:hover{color:var(--ink);border-color:var(--faint)}
  .btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
  .btn.primary:hover{filter:brightness(1.2)}
  .btn:disabled{opacity:.45;cursor:default}
  .row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--line-2);
    font-size:13px}
  .row:last-child{border-bottom:0}
  .row .k{font-family:var(--mono);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;
    white-space:nowrap;flex:1 1 auto;min-width:7ch}
  .row .when{margin-left:auto;color:var(--faint);font-size:12px;font-variant-numeric:tabular-nums;
    white-space:nowrap;flex:none}
  .dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--faint)}
  .dot.ok{background:var(--ok)} .dot.warn{background:var(--warn)} .dot.bad{background:var(--bad)}
  .dot.go{background:var(--ink)}
  .bar{height:4px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:10px}
  .bar i{display:block;height:100%;background:var(--accent)}
  .empty{border:1px dashed var(--line);border-radius:var(--r);padding:26px;color:var(--faint);
    font-size:13px;text-align:center;line-height:1.65;background:var(--panel)}
  .empty b{display:block;color:var(--dim);font-size:13.5px;margin-bottom:5px}

  /* --------------------------------------------------------- assets --- */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(146px,1fr));gap:13px}
  .asset{all:unset;cursor:zoom-in;border-radius:var(--r-sm);overflow:hidden;background:var(--panel);
    border:1px solid var(--line);display:flex;flex-direction:column}
  .asset:hover{border-color:var(--accent)}
  .asset .thumb{aspect-ratio:4/3;background:var(--sunk);display:block;width:100%;object-fit:cover}
  .asset .cap{padding:9px 11px 11px;display:flex;flex-direction:column;gap:3px}
  .asset .cap b{font-size:12px;font-weight:550;line-height:1.4;color:var(--ink);
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .asset .cap b.none{color:var(--faint);font-style:italic;font-weight:400}
  .asset .cap span{font-size:10.5px;color:var(--faint);font-family:var(--mono)}
  .strip{display:flex;gap:9px;overflow-x:auto;padding-bottom:4px}
  .strip button{all:unset;cursor:zoom-in;flex:none;width:76px}
  .strip img{width:76px;height:57px;object-fit:cover;border-radius:9px;border:1px solid var(--line);
    display:block}
  .strip button:hover img{border-color:var(--faint)}

  /* --------------------------------------------------------- viewer --- */
  dialog{border:0;padding:0;background:transparent;max-width:min(1080px,94vw);width:100%}
  dialog::backdrop{background:rgb(8 10 14/72%);backdrop-filter:blur(3px)}
  .viewer{background:var(--panel);border-radius:var(--r);overflow:hidden;display:grid;
    grid-template-columns:1.5fr 1fr;max-height:88vh}
  @media (max-width:760px){ .viewer{grid-template-columns:1fr;max-height:92vh;overflow:auto} }
  .viewer .stage{background:var(--sunk);display:grid;place-items:center;padding:18px;min-height:280px}
  .viewer .stage img{max-width:100%;max-height:74vh;object-fit:contain;border-radius:8px}
  .viewer .meta{padding:20px;display:flex;flex-direction:column;gap:14px;overflow:auto}
  .viewer h3{margin:0;font-size:15px}
  .field label{display:block;font-size:10.5px;font-weight:700;letter-spacing:.11em;
    text-transform:uppercase;color:var(--faint);margin-bottom:6px}
  .field textarea{width:100%;min-height:88px;resize:vertical;font:inherit;font-size:13px;
    padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--sunk);
    color:var(--ink);line-height:1.55}
  .field textarea:focus{outline:2px solid var(--accent);outline-offset:-1px}
  .field p{margin:0;font-size:12.5px;color:var(--dim);line-height:1.6;white-space:pre-wrap;
    word-break:break-word}
  .field p.none{color:var(--faint);font-style:italic}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:12px;font-family:var(--mono);
    color:var(--dim)}
  .kv b{color:var(--faint);font-weight:500}
  .viewer .foot{display:flex;gap:8px;align-items:center;margin-top:auto;padding-top:6px}
  .saved{font-size:12px;color:var(--ok);opacity:0;transition:opacity .2s}
  .saved.on{opacity:1}

  .log{font-family:var(--mono);font-size:11.5px;line-height:1.7;background:var(--panel);
    border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;overflow:auto;
    max-height:56vh;white-space:pre-wrap;color:var(--dim);margin:0}
  .paths{color:var(--faint);font-size:11.5px;font-family:var(--mono);margin-top:12px;
    word-break:break-all;line-height:1.6}

  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand">
      <span class="glyph">A</span>
      <div><b>Atelier</b><br><span>v${version}</span></div>
    </div>

    <p class="navlabel">Main menu</p>
    <nav class="nav" id="nav" role="tablist" aria-label="Sections">
      <button role="tab" id="tab-overview" data-tab="overview" aria-controls="panel-overview">
        <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/></svg>
        Overview
      </button>
      <button role="tab" id="tab-workflows" data-tab="workflows" aria-controls="panel-workflows">
        <svg viewBox="0 0 24 24"><path d="M5 6h14M5 12h9M5 18h5"/><circle cx="19" cy="16" r="3"/></svg>
        Workflows<span class="badge" id="badge-workflows" hidden></span>
      </button>
      <button role="tab" id="tab-runs" data-tab="runs" aria-controls="panel-runs">
        <svg viewBox="0 0 24 24"><path d="M4 18V9M9.5 18V5M15 18v-6M20.5 18v-9"/></svg>
        Runs<span class="badge" id="badge-runs" hidden></span>
      </button>
      <button role="tab" id="tab-assets" data-tab="assets" aria-controls="panel-assets">
        <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 4.5-4.5 3.5 3.5 3-3L20 18"/></svg>
        Assets
      </button>
      <button role="tab" id="tab-log" data-tab="log" aria-controls="panel-log">
        <svg viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="M8.5 9h7M8.5 13h7M8.5 17h4"/></svg>
        Log
      </button>
    </nav>

    <div class="sidestat" id="sidestat">
      <div class="dotline"><i></i><span id="sidestat-text">connecting</span></div>
      <p id="sidestat-sub"></p>
    </div>
  </aside>

  <main class="main">
    <div class="head">
      <div>
        <h1 id="page-title">Overview</h1>
        <p id="page-sub">Local asset pipeline</p>
      </div>
      <span class="live" id="live"><i></i><span id="live-text">live</span></span>
    </div>

    <!-- Never behind a tab. A parked job and a detached browser are the states
         where Atelier is stuck waiting on a person. -->
    <div id="attention"></div>

    <div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
      <section class="kpis" id="kpis"></section>

      <section class="split">
        <div class="card pad">
          <div class="sec-head">
            <h2>Runs</h2>
            <span class="chart-legend">
              <span><i style="background:var(--ok)"></i>succeeded</span>
              <span><i style="background:var(--bad)"></i>failed</span>
            </span>
          </div>
          <div id="chart-runs"></div>
        </div>
        <div class="card pad">
          <div class="sec-head"><h2>Outcomes</h2></div>
          <div class="donut-wrap"><div id="chart-donut"></div>
            <div class="donut-legend" id="donut-legend"></div></div>
        </div>
      </section>

      <section class="split" style="grid-template-columns:minmax(0,1fr) minmax(0,1.15fr)">
        <div style="min-width:0">
          <div class="sec-head"><h2>Workflows</h2>
            <button class="btn more" data-goto="workflows">See all</button></div>
          <div class="card pad" id="ov-workflows"></div>
        </div>
        <div>
          <div class="sec-head"><h2>Latest assets</h2>
            <button class="btn more" data-goto="assets">See all</button></div>
          <div class="card pad" id="ov-assets"></div>
        </div>
      </section>
    </div>

    <div role="tabpanel" id="panel-workflows" aria-labelledby="tab-workflows" hidden>
      <div id="workflows"></div>
    </div>

    <div role="tabpanel" id="panel-runs" aria-labelledby="tab-runs" hidden>
      <section class="card pad">
        <div class="sec-head"><h2>Last 14 days</h2></div>
        <div id="chart-runs-2"></div>
      </section>
      <section id="active-sec" hidden>
        <div class="sec-head"><h2>In flight</h2></div>
        <div id="active"></div>
      </section>
      <section>
        <div class="sec-head"><h2>By workflow</h2></div>
        <div class="card pad" id="recent"></div>
      </section>
    </div>

    <div role="tabpanel" id="panel-assets" aria-labelledby="tab-assets" hidden>
      <div class="grid" id="assets"></div>
      <div id="assets-empty"></div>
    </div>

    <div role="tabpanel" id="panel-log" aria-labelledby="tab-log" hidden>
      <pre class="log" id="log">…</pre>
      <p class="paths" id="paths"></p>
    </div>
  </main>
</div>

<dialog id="viewer">
  <div class="viewer">
    <div class="stage"><img id="v-img" alt=""></div>
    <div class="meta">
      <h3 id="v-title">Asset</h3>
      <div class="field">
        <label for="v-desc">Description</label>
        <textarea id="v-desc" placeholder="What does this actually show? One or two sentences."></textarea>
      </div>
      <div class="field">
        <label>Prompt</label>
        <p id="v-prompt"></p>
      </div>
      <div class="field">
        <label>Details</label>
        <div class="kv" id="v-kv"></div>
      </div>
      <div class="foot">
        <button class="btn primary" id="v-save">Save description</button>
        <button class="btn" id="v-open">Open original</button>
        <button class="btn" id="v-close">Close</button>
        <span class="saved" id="v-saved">Saved</span>
      </div>
    </div>
  </div>
</dialog>

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
const kb = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'kB'

/* -------------------------------------------------------------- tabs --- */

const TABS = ['overview', 'workflows', 'runs', 'assets', 'log']
const TITLES = {
  overview: ['Overview', 'A little of everything, so the first screen answers the question'],
  workflows: ['Workflows', 'What this machine can do, and whether it still can'],
  runs: ['Runs', 'What has run, and how it went'],
  assets: ['Assets', 'What the workflows produced'],
  log: ['Log', 'The daemon, verbatim'],
}

/* Held outside render(), which runs on every state frame and every 25s
   regardless. Deriving the visible tab from the data would snap the page back
   under the reader mid-sentence. */
let currentTab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview'
let latest = null

function applyTab() {
  for (const t of TABS) {
    const tab = $('tab-' + t), panel = $('panel-' + t)
    if (!tab || !panel) continue
    const on = t === currentTab
    tab.setAttribute('aria-selected', on ? 'true' : 'false')
    tab.tabIndex = on ? 0 : -1
    panel.hidden = !on
  }
  $('page-title').textContent = TITLES[currentTab][0]
  $('page-sub').textContent = TITLES[currentTab][1]
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
$('nav').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]')
  if (t) goTab(t.dataset.tab)
})
$('nav').addEventListener('keydown', (e) => {
  const i = TABS.indexOf(currentTab)
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') goTab(TABS[(i + 1) % TABS.length], { focus: true })
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') goTab(TABS[(i - 1 + TABS.length) % TABS.length], { focus: true })
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

/* ------------------------------------------------------------ charts --- */

/** Stacked bars, hand-drawn. A chart that needs the network is a chart that
 *  fails exactly when you have opened the dashboard to find out why. */
function barChart(series) {
  const W = 100, H = 40, gap = 1.4
  const max = Math.max(1, ...series.map(d => d.ok + d.failed))
  const bw = (W - gap * (series.length - 1)) / series.length
  let svg = '<svg viewBox="0 0 ' + W + ' ' + (H + 8) + '" width="100%" height="150" role="img" ' +
    'aria-label="Runs per day for the last ' + series.length + ' days" preserveAspectRatio="none">'
  series.forEach((d, i) => {
    const x = i * (bw + gap)
    const total = d.ok + d.failed
    if (!total) {
      svg += '<rect x="' + x + '" y="' + (H - 1) + '" width="' + bw + '" height="1" rx=".5" fill="currentColor" opacity=".12"/>'
    } else {
      const h = (total / max) * H
      const okH = (d.ok / total) * h
      const failH = h - okH
      if (failH > 0) svg += '<rect x="' + x + '" y="' + (H - h) + '" width="' + bw + '" height="' + failH + '" rx=".8" fill="var(--bad)"/>'
      svg += '<rect x="' + x + '" y="' + (H - okH) + '" width="' + bw + '" height="' + okH + '" rx=".8" fill="var(--ok)" opacity=".85"/>'
    }
    svg += '<title>' + d.day + ': ' + d.ok + ' ok, ' + d.failed + ' failed</title>'
  })
  svg += '</svg>'
  const first = series[0], last = series[series.length - 1]
  return svg + '<div class="wf-meta" style="justify-content:space-between;margin-top:6px">' +
    '<span>' + (first ? first.day.slice(5) : '') + '</span><span>' + (last ? last.day.slice(5) : '') + '</span></div>'
}

function donut(parts) {
  const total = parts.reduce((n, p) => n + p.n, 0)
  const R = 46, C = 2 * Math.PI * R
  let offset = 0
  let svg = '<svg viewBox="0 0 120 120" width="164" height="164" role="img" aria-label="Run outcomes">' +
    '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="var(--line)" stroke-width="15"/>'
  if (total) {
    for (const p of parts) {
      if (!p.n) continue
      const len = (p.n / total) * C
      svg += '<circle cx="60" cy="60" r="' + R + '" fill="none" stroke="' + p.color + '" stroke-width="15" ' +
        'stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-offset) + '" ' +
        'transform="rotate(-90 60 60)" stroke-linecap="butt"><title>' + p.label + ': ' + p.n + '</title></circle>'
      offset += len
    }
  }
  svg += '<text x="60" y="57" text-anchor="middle" font-size="21" font-weight="700" fill="var(--ink)">' +
    total + '</text>' +
    '<text x="60" y="72" text-anchor="middle" font-size="9" fill="var(--faint)">' +
    (total === 1 ? 'run' : 'runs') + '</text></svg>'
  return svg
}

/* ------------------------------------------------------------- cards --- */

function runStrip(runs) {
  if (!runs || !runs.total) return '<span>never run</span>'
  const marks = (runs.recent || []).map(s =>
    '<i class="' + (s === 'done' ? '' : s === 'failed' || s === 'cancelled' ? 'bad' : '') + '"></i>').join('')
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
  const stateTag = pending
    ? '<span class="tag go">awaiting you</span>'
    : health.state === 'fragile' ? '<span class="tag bad">fragile</span>'
    : health.state === 'degraded' ? '<span class="tag warn">degrading</span>'
    : health.state === 'ok' ? '<span class="tag ok">healthy</span>'
    : '<span class="tag">not run yet</span>'

  const actions = (pending ? '<button class="btn primary" data-activate="' + esc(w.name) + '">Activate</button>' : '') +
    '<button class="btn" data-workflow="' + esc(w.name) + '">Delete</button>'

  const list = (w.stepList || []).map(s => '<li>' + esc(s.note) + '</li>').join('')
  const steps = !pending || !list ? ''
    : (w.stepList.length > 6
        ? '<details class="steps"><summary>' + plural(w.stepList.length, 'step') + '</summary><ol>' + list + '</ol></details>'
        : '<ol class="steps">' + list + '</ol>')

  // At most one note per card. Two stacked explanations is a paragraph.
  let note = ''
  if (pending) note = '<div class="note info">Recorded and written up. Nothing runs until you activate it.</div>'
  else if (health.state === 'fragile' || health.state === 'degraded') {
    const worst = (health.degraded || [])[0]
    note = '<div class="note ' + (health.state === 'fragile' ? 'bad' : 'warn') + '">' +
      esc(health.summary) + (worst ? '<br>' + esc(worst.note) + ' — re-record that step from the side panel.' : '') + '</div>'
  }

  return '<article class="wf ' + tone + '"><div class="wf-top">' +
    '<span class="wf-name">' + esc(w.name) + '</span>' +
    '<span class="tag">' + esc(w.produces) + '</span>' + stateTag +
    '<span class="wf-actions">' + actions + '</span></div>' +
    '<p class="wf-desc">' + esc(w.description) + '</p>' +
    '<div class="wf-meta"><span>' + plural(w.steps, 'step') + '</span>' +
    '<span>' + esc((w.origins || []).join(', ')) + '</span>' + runStrip(w.runs) + '</div>' +
    note + steps + '</article>'
}

function assetCard(a, i) {
  const what = a.description
    ? '<b>' + esc(a.description) + '</b>'
    : '<b class="none">No description yet</b>'
  return '<button class="asset" data-asset="' + i + '">' +
    (a.mime.indexOf('image/') === 0
      ? '<img class="thumb" loading="lazy" src="/asset/' + a.id + '" alt="">'
      : '<span class="thumb"></span>') +
    '<span class="cap">' + what +
    '<span>' + (a.width ? a.width + '×' + a.height : kb(a.bytes)) + ' · ' + ago(a.createdAt) + '</span>' +
    '</span></button>'
}

/* ------------------------------------------------------------ render --- */

function render(d) {
  latest = d
  const blocked = d.jobs.filter(j => j.status === 'blocked')
  const active = d.jobs.filter(j => j.status === 'running' || j.status === 'queued')
  const attached = d.browsers.length > 0
  const decaying = (d.unhealthy || []).length
  const toActivate = (d.pendingActivation || []).length

  /* -- the system's own state, in one place ---------------------------- */
  const state = blocked.length ? 'bad' : !attached ? 'warn' : 'ok'
  $('sidestat').className = 'sidestat ' + state
  $('sidestat-text').textContent = blocked.length
    ? plural(blocked.length, 'job') + ' waiting on you'
    : !attached ? 'No browser attached'
    : active.length ? plural(active.length, 'job') + ' running' : 'Ready'
  $('sidestat-sub').textContent = ':' + d.port + ' · up ' + dur(d.uptimeSeconds) + '\\n' +
    (attached ? d.browsers.map(b => b.label).join(', ') : 'extension not connected')

  /* -- attention: only what is true, and never twice ------------------- */
  const cards = []
  for (const j of blocked) {
    cards.push('<div class="wf fragile" style="margin-bottom:14px"><div class="wf-top">' +
      '<span class="wf-name">' + esc(j.workflowName) + '</span>' +
      '<span class="tag bad">paused</span></div>' +
      '<p class="wf-desc">' + esc(j.blockedReason || 'Paused.') + ' Resume it from the Atelier side panel.</p></div>')
  }
  if (!attached) {
    cards.push('<div class="wf" style="margin-bottom:14px;border-color:var(--warn)"><div class="wf-top">' +
      '<span class="wf-name">No browser attached</span><span class="tag warn">connect</span></div>' +
      '<p class="wf-desc">Load the extension from <code>atelier/extension/</code> at ' +
      '<code>chrome://extensions</code>, then open any tab. Workflows cannot run until one is.</p></div>')
  }
  $('attention').innerHTML = cards.join('')

  setBadge('workflows', decaying + toActivate, '')
  setBadge('runs', active.length, '')

  /* -- KPIs: three numbers that are actually the questions -------------- */
  const wfs = d.workflows
  // A workflow that has not run yet is unverified, not unhealthy — counting it
  // as a failure made a library with nothing wrong with it read "0/2".
  const activeWfs = wfs.filter(w => w.status === 'active')
  const holding = activeWfs.filter(w => {
    const st = w.health && w.health.state
    return st !== 'degraded' && st !== 'fragile'
  }).length
  const totalRuns = wfs.reduce((n, w) => n + ((w.runs && w.runs.total) || 0), 0)
  const okRuns = wfs.reduce((n, w) => n + ((w.runs && w.runs.ok) || 0), 0)
  const rate = totalRuns ? Math.round((okRuns / totalRuns) * 100) : 0
  const described = d.assets.filter(a => a.description).length

  $('kpis').innerHTML =
    kpi('k1', iconCheck, 'Workflow health',
      decaying ? plural(decaying, 'decaying', 'decaying') : activeWfs.length ? 'all holding' : 'none yet',
      activeWfs.length ? holding + '/' + activeWfs.length : '—',
      decaying
        ? plural(decaying, 'workflow') + ' matching on weaker selectors than recorded'
        : activeWfs.length ? 'every step matching as recorded' : 'record one to get started',
      'workflows') +
    kpi('k2', iconPulse, 'Run success', totalRuns ? plural(totalRuns, 'run') : 'no runs',
      totalRuns ? rate + '%' : '—',
      totalRuns ? okRuns + ' of ' + totalRuns + ' finished' : 'nothing has run yet',
      'runs') +
    kpi('k3', iconImage, 'Assets', described + ' described',
      String(d.counts.assets),
      described === d.counts.assets && described
        ? 'every one has a description'
        : (d.counts.assets - described) + ' still need a description',
      'assets')

  /* -- charts ---------------------------------------------------------- */
  const series = d.runsByDay || []
  $('chart-runs').innerHTML = barChart(series)
  $('chart-runs-2').innerHTML = barChart(series)
  const failedRuns = totalRuns - okRuns
  $('chart-donut').innerHTML = donut([
    { label: 'succeeded', n: okRuns, color: 'var(--ok)' },
    { label: 'failed', n: failedRuns, color: 'var(--bad)' },
  ])
  $('donut-legend').innerHTML = totalRuns
    ? '<div><i style="background:var(--ok)"></i>Succeeded<b>' + okRuns + '</b></div>' +
      '<div><i style="background:var(--bad)"></i>Failed<b>' + failedRuns + '</b></div>'
    : '<div style="color:var(--faint)">Nothing has run yet.</div>'

  /* -- overview lists --------------------------------------------------- */
  $('ov-workflows').innerHTML = wfs.length
    ? wfs.slice(0, 5).map(w => {
        const st = w.status === 'draft' ? 'go' : (w.health && w.health.state) === 'ok' ? 'ok'
          : (w.health && w.health.state) === 'fragile' ? 'bad'
          : (w.health && w.health.state) === 'degraded' ? 'warn' : ''
        return '<div class="row"><i class="dot ' + st + '"></i>' +
          '<span class="k">' + esc(w.name) + '</span>' +
          '<span class="when">' + ((w.runs && w.runs.total) ? plural(w.runs.total, 'run') + ' · ' + ago(w.runs.lastAt) : 'never run') + '</span></div>'
      }).join('')
    : '<div style="color:var(--faint);font-size:13px">Nothing recorded yet.</div>'

  $('ov-assets').innerHTML = d.assets.length
    ? '<div class="strip">' + d.assets.slice(0, 10).map((a, i) =>
        '<button data-asset="' + i + '" title="' + esc(a.description || a.prompt || '') + '">' +
        '<img loading="lazy" src="/asset/' + a.id + '" alt=""></button>').join('') + '</div>'
    : '<div style="color:var(--faint);font-size:13px">Nothing produced yet.</div>'

  /* -- workflows -------------------------------------------------------- */
  $('workflows').innerHTML = wfs.length
    ? wfs.map(workflowCard).join('')
    : '<div class="empty"><b>Nothing recorded yet</b>' +
      'Open the site you want to automate, click the Atelier icon, and hit Record a workflow.</div>'

  /* -- runs -------------------------------------------------------------- */
  $('active-sec').hidden = !active.length
  $('active').innerHTML = active.map(j =>
    '<article class="wf"><div class="wf-top"><span class="wf-name">' + esc(j.workflowName) + '</span>' +
    '<span class="tag">step ' + (j.stepIndex + 1) + ' of ' + j.stepCount + '</span></div>' +
    '<div class="bar"><i style="width:' + (j.stepCount ? (j.stepIndex / j.stepCount) * 100 : 0) + '%"></i></div></article>').join('')

  const ran = wfs.filter(w => w.runs && w.runs.total)
  $('recent').innerHTML = ran.length
    ? ran.map(w =>
        '<div class="row"><span class="k">' + esc(w.name) + '</span>' +
        '<span class="tag ' + (w.runs.failed ? 'bad' : 'ok') + '">' +
        (w.runs.failed ? w.runs.failed + ' failed' : 'all fine') + '</span>' +
        '<span class="runs">' + (w.runs.recent || []).map(s =>
          '<i class="' + (s === 'done' ? '' : 'bad') + '"></i>').join('') + '</span>' +
        '<span class="when">' + plural(w.runs.total, 'run') + ' · ' + ago(w.runs.lastAt) + '</span></div>').join('')
    : '<div style="color:var(--faint);font-size:13px">Nothing has run yet.</div>'

  /* -- assets ------------------------------------------------------------ */
  $('assets').innerHTML = d.assets.map(assetCard).join('')
  $('assets-empty').innerHTML = d.assets.length ? ''
    : '<div class="empty"><b>Nothing produced yet</b>Assets a workflow captures land here, with the prompt that made them.</div>'

  /* -- log --------------------------------------------------------------- */
  $('log').textContent = d.log || '(empty)'
  $('paths').textContent = 'State in ' + d.home

  // A viewer left open must follow the data, or it shows a stale description
  // the moment anything else edits one.
  if ($('viewer').open && openAsset != null) {
    const fresh = d.assets.find(a => a.id === openAsset)
    if (fresh) fillViewer(fresh)
  }
}

const iconCheck = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.6 2.6L16 9.5"/></svg>'
const iconPulse = '<svg viewBox="0 0 24 24"><path d="M3 12h4l2.5-6 4 12L16 12h5"/></svg>'
const iconImage = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 4.5-4.5 3.5 3.5 3-3L20 18"/></svg>'

function kpi(tone, icon, title, chip, big, sub, goto) {
  return '<div class="kpi ' + tone + '"><div class="top">' + icon + title + '</div>' +
    '<div class="big">' + big + '<span class="chip">' + esc(chip) + '</span></div>' +
    '<div class="sub">' + esc(sub) + '</div>' +
    '<button class="go" data-goto="' + goto + '">See details →</button></div>'
}

/* ------------------------------------------------------------ viewer --- */

let openAsset = null

function fillViewer(a) {
  openAsset = a.id
  $('v-img').src = '/asset/' + a.id
  $('v-title').textContent = a.workflowName ? a.workflowName : 'Asset'
  if (document.activeElement !== $('v-desc')) $('v-desc').value = a.description || ''
  $('v-prompt').textContent = a.prompt || 'No prompt recorded.'
  $('v-prompt').className = a.prompt ? '' : 'none'
  $('v-kv').innerHTML =
    '<b>id</b><span>' + esc(a.id) + '</span>' +
    '<b>type</b><span>' + esc(a.mime) + '</span>' +
    (a.width ? '<b>size</b><span>' + a.width + '×' + a.height + '</span>' : '') +
    '<b>bytes</b><span>' + kb(a.bytes) + '</span>' +
    '<b>made</b><span>' + a.createdAt.slice(0, 16).replace('T', ' ') + '</span>'
}

function openViewer(a) {
  fillViewer(a)
  $('v-saved').className = 'saved'
  $('viewer').showModal()
}

$('v-close').onclick = () => $('viewer').close()
$('v-open').onclick = () => { if (openAsset) window.open('/asset/' + openAsset, '_blank') }
$('v-save').onclick = async () => {
  if (!openAsset) return
  $('v-save').disabled = true
  try {
    await post('/api/assets.describe', { id: openAsset, description: $('v-desc').value })
    $('v-saved').className = 'saved on'
    setTimeout(() => { $('v-saved').className = 'saved' }, 1800)
  } catch (e) {
    alert('Could not save: ' + e.message)
  } finally {
    $('v-save').disabled = false
  }
}
// Clicking the backdrop closes, which is what everyone expects of a lightbox.
$('viewer').addEventListener('click', (e) => { if (e.target === $('viewer')) $('viewer').close() })
$('viewer').addEventListener('close', () => { openAsset = null })

/* ----------------------------------------------------------- actions --- */

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const payload = await res.json()
  if (payload.ok === false) throw new Error(payload.error)
  return payload.result
}

document.addEventListener('click', async (e) => {
  const goto = e.target.closest('[data-goto]')
  if (goto) return goTab(goto.dataset.goto)

  const asset = e.target.closest('[data-asset]')
  if (asset && latest) return openViewer(latest.assets[Number(asset.dataset.asset)])

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
source.onopen = () => { $('live').className = 'live'; $('live-text').textContent = 'live' }
source.onerror = () => { $('live').className = 'live dead'; $('live-text').textContent = 'reconnecting' }
</script>
</body>
</html>`
