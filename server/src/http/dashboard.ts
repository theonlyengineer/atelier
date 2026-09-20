/**
 * The dashboard at http://127.0.0.1:7717 — the answer to "is it working, what
 * can it do, and does anything need me?"
 *
 * Deliberately not the same thing as the extension popup. The popup is the
 * *action* surface: the one or two things that need a human, on the page they
 * are looking at. This is the *observation* surface, and the place where a
 * workflow is opened up, tried, turned off, or thrown away.
 *
 * It is scanned, not read, and three rules follow. **Aggregate, never
 * enumerate** — fifteen rows reading "done · 2d ago" is a log wearing a
 * summary's clothes. **Say a thing once** — an earlier version reported a
 * detached browser in a stat, a banner and a section, which teaches a reader
 * that none of the three is worth reading. And **the overview shows a little of
 * everything**, so the first screen answers the question rather than asking
 * which tab you want.
 *
 * Everything below the header belongs to **one project**. The switcher in the
 * header is the frame the whole page is read inside, which is why it sits up
 * there with the other things that are about the page rather than about the
 * work — and why the sidebar holds nothing but the sections of that one
 * project.
 *
 * One self-contained file: no build step, no framework, no external requests.
 * The charts are hand-drawn SVG for the same reason — a dashboard that cannot
 * render without reaching the network is a dashboard that fails exactly when
 * you need it. It updates over Server-Sent Events, so there is nothing to
 * refresh and no polling.
 *
 * One editing hazard, since this whole page is a TypeScript template literal:
 * a backtick anywhere inside it — including in a comment — closes the string.
 * The build catches it as a syntax error twenty lines later, which is a
 * confusing place to be told. Do not quote identifiers with backticks in here.
 */

export const dashboardHtml = (version: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atelier</title>
<script>
  /* Before first paint, or a remembered light choice flashes dark on every
     reload. Same for the drawer: a sidebar that expands and then snaps shut on
     load is worse than one that was never animated. Wrapped because storage
     throws outright in some privacy modes, and a dashboard that will not render
     is worse than one in the wrong colours. */
  try {
    var t = localStorage.getItem('atelier:theme')
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
    if (localStorage.getItem('atelier:drawer') === 'closed') document.documentElement.dataset.drawer = 'closed'
  } catch (e) {}
</script>
<style>
  /*
   * The house palette: warm paper, hard rules, vermilion. Dark is the default,
   * light is a switch in the header, and the choice is remembered.
   *
   * Both are the same paper. The house ground is a warm off-white, so the dark
   * ground is a warm near-black rather than a blue-grey, and every accent is the
   * same hue lifted until it holds its contrast against it. A dark mode built
   * from a different palette stops being the same product with the lights off.
   *
   * Plus one addition the site does not need and a dashboard does. Running on
   * the accent alone meant success had no colour of its own, and "92% of runs
   * succeeded" was drawn in the shade reserved for things going wrong — which
   * is worse than off-palette, it is the opposite of what it says.
   */
  :root{
    --page:#14120F;
    --panel:#1C1916;
    --sunk:#211D19;
    --ink:#F7F2EA;
    --dim:rgb(247 242 234/72%);
    --faint:rgb(247 242 234/46%);
    --line:rgb(247 242 234/16%);
    --line-2:rgb(247 242 234/9%);
    --accent:#FF6552;
    --accent-soft:#3B1B16;
    --ok:#6BC992;
    --ok-soft:#17301F;
    --warn:#E0A64C;
    --warn-soft:#332616;
    --bad:#FF6552;
    --bad-soft:#3B1B16;
    --k1:#211D19;
    --k1-ink:#F7F2EA;
    --k2:#17301F;
    --k2-ink:#8FDDB0;
    --k3:#2E2822;          /* lifted, not inverted: three tones of one dark
                              paper. Inverting the light theme's black tile
                              would put a white slab on a dark page. */
    --k3-ink:#F7F2EA;
    --on-tile-soft:rgb(255 255 255/11%);
    --on-tile-cta:rgb(255 255 255/10%);
    --r:10px; --r-sm:7px;
    --side:236px;
    /* Slight, and not linear. A drawer that eases out of the way reads as one
       movement; a linear one reads as a value changing. */
    --ease:cubic-bezier(.22,.61,.36,1);
    --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    --serif:ui-serif,Georgia,"Times New Roman",serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  :root[data-theme="light"]{
    --page:#FFFBF5;
    --panel:#FFFFFF;
    --sunk:#F8F4EC;
    --ink:#000000;
    --dim:rgb(0 0 0/68%);
    --faint:rgb(0 0 0/46%);
    --line:rgb(0 0 0/14%);
    --line-2:rgb(0 0 0/8%);
    --accent:#FE402E;
    --accent-soft:#FFEBE7;
    --ok:#256E45;
    --ok-soft:#E6F1E9;
    --warn:#9A6410;
    --warn-soft:#FBF0DE;
    --bad:#FE402E;
    --bad-soft:#FFEBE7;
    --k1:#F8F4EC;
    --k1-ink:#1A1A1A;
    --k2:#E6F1E9;
    --k2-ink:#1C5A38;
    --k3:#111111;
    --k3-ink:#FFFBF5;
    --on-tile-soft:rgb(0 0 0/8%);
    --on-tile-cta:rgb(255 255 255/80%);
  }
  :root[data-drawer="closed"]{--side:68px}

  /* color-scheme follows the attribute so form controls, scrollbars and the
     caret come from the right set without any of them being restyled by hand. */
  :root{color-scheme:dark}
  :root[data-theme="light"]{color-scheme:light}
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  html,body{height:100%}
  body{margin:0;background:var(--page);color:var(--ink);
    font:14px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
  h1,h2,h3,.kpi .big,.brand b{font-family:var(--serif)}
  button{font:inherit}
  ::selection{background:var(--accent-soft)}
  .mono{font-family:var(--mono)}
  code{font-family:var(--mono);font-size:.86em;background:var(--sunk);padding:.12em .38em;border-radius:5px}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}

  /* ---------------------------------------------------------- shell --- */
  .app{display:grid;grid-template-columns:var(--side) 1fr;min-height:100vh;
    transition:grid-template-columns .26s var(--ease)}

  /* ----------------------------------------------------------- side --- */
  /*
   * Only the sections of the project on screen. The project switcher used to
   * sit at the top of this column; it is in the header now, because it is the
   * frame everything here is read inside rather than one more thing to
   * navigate to.
   */
  .side{background:var(--panel);border-right:1px solid var(--line);
    display:flex;flex-direction:column;gap:18px;position:sticky;top:0;height:100vh;
    padding:18px 12px 14px;overflow:hidden}
  .brand{display:flex;align-items:center;gap:10px;padding:0 6px;height:30px;flex:none}
  .brand .glyph{width:28px;height:28px;border-radius:8px;background:var(--accent);color:#fff;
    display:grid;place-items:center;font-weight:800;font-size:14px;flex:none;
    font-family:var(--serif)}
  .brand b{font-size:16px;letter-spacing:-.01em;white-space:nowrap}

  .nav{display:flex;flex-direction:column;gap:2px}
  .nav button{all:unset;cursor:pointer;display:flex;align-items:center;gap:12px;padding:9px 10px;
    border-radius:10px;color:var(--dim);font-size:13.5px;white-space:nowrap}
  .nav button:hover{background:var(--sunk);color:var(--ink)}
  .nav button[aria-selected="true"]{background:var(--ink);color:var(--page);font-weight:600}
  .nav svg{width:18px;height:18px;flex:none;stroke:currentColor;fill:none;stroke-width:1.7;
    stroke-linecap:round;stroke-linejoin:round}
  .nav .badge{margin-left:auto;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;
    background:var(--bad-soft);color:var(--bad);font-variant-numeric:tabular-nums}
  .nav button[aria-selected="true"] .badge{background:var(--panel);color:var(--ink)}

  /* Collapsed, every row is its icon — including the wordmark, which becomes
     the glyph it already starts with. The labels are not merely hidden: they
     are taken out of the layout, or the row stays as wide as its text and the
     column scrolls sideways. */
  :root[data-drawer="closed"] .nav .label-text,
  :root[data-drawer="closed"] .nav .badge,
  :root[data-drawer="closed"] .brand b{display:none}
  :root[data-drawer="closed"] .nav button{justify-content:center;padding:10px 0}
  :root[data-drawer="closed"] .brand{justify-content:center;padding:0}

  /* The version, at the foot of the column. It used to sit next to the
     wordmark, where it read as part of the name. */
  .side-version{margin-top:auto;text-align:center;font-family:var(--mono);font-size:10px;
    color:var(--faint);flex:none;white-space:nowrap}

  /* ---------------------------------------------------------- head --- */
  /*
   * The header starts where the sidebar ends and runs to the far edge. The
   * drawer handle is its leftmost thing, so the control that moves the boundary
   * sits on the boundary.
   */
  .wrap{min-width:0;display:flex;flex-direction:column}
  .head{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:12px;
    padding:12px 22px;background:var(--panel);border-bottom:1px solid var(--line)}
  .head h1{margin:0;font-size:17px;font-weight:700;letter-spacing:-.01em;line-height:1.2;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .head .sub{color:var(--faint);font-size:12px;white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis;min-width:0}
  .head-right{margin-left:auto;display:flex;align-items:center;gap:8px}

  .hbtn{all:unset;cursor:pointer;display:grid;place-items:center;width:34px;height:34px;
    border-radius:9px;color:var(--dim);flex:none}
  .hbtn:hover{background:var(--sunk);color:var(--ink)}
  .hbtn svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.7;
    stroke-linecap:round;stroke-linejoin:round}
  /* One button, two icons, and the one you can see is the one you would get.
     A switch labelled with the state it is already in is the oldest confusing
     control there is. */
  #theme .sun{display:none}
  :root[data-theme="light"] #theme .sun{display:block}
  :root[data-theme="light"] #theme .moon{display:none}

  .hlink{all:unset;cursor:pointer;display:flex;align-items:center;gap:7px;padding:7px 12px;
    border-radius:9px;color:var(--dim);font-size:13px;white-space:nowrap}
  .hlink:hover{background:var(--sunk);color:var(--ink)}
  .hlink[aria-selected="true"]{background:var(--sunk);color:var(--ink);font-weight:600}
  .hlink svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.7;
    stroke-linecap:round;stroke-linejoin:round}

  /* ---- project switcher, in the header -------------------------------- */
  .switcher{position:relative;flex:none}
  .switcher > button{all:unset;cursor:pointer;display:flex;align-items:center;gap:9px;
    padding:7px 12px;border-radius:9px;border:1px solid var(--line);background:var(--sunk);
    font-size:13px;font-weight:600;max-width:220px}
  .switcher > button:hover{border-color:var(--faint)}
  .proj-dot{width:7px;height:7px;border-radius:2px;background:var(--accent);flex:none}
  .proj-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .proj-caret{color:var(--faint);font-size:10px;margin-left:auto}
  .proj-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:40;margin:0;padding:5px;
    list-style:none;background:var(--panel);border:1px solid var(--line);border-radius:11px;
    min-width:240px;max-height:340px;overflow:auto;box-shadow:0 16px 40px rgb(0 0 0/22%)}
  .proj-menu li button{all:unset;cursor:pointer;display:block;width:100%;box-sizing:border-box;
    padding:8px 10px;border-radius:8px;font-size:13px}
  .proj-menu li button:hover{background:var(--sunk)}
  .proj-menu li button[aria-selected="true"]{background:var(--ink);color:var(--page);font-weight:600}
  .proj-menu .meta{display:block;font-size:10.5px;color:var(--faint);font-family:var(--mono);
    margin-top:2px}
  .proj-menu li button[aria-selected="true"] .meta{color:var(--page);opacity:.7}

  @media (max-width:760px){
    .app{grid-template-columns:var(--side)}
    .head .sub{display:none}
    .hlink span{display:none}
  }

  /* ----------------------------------------------------------- main --- */
  .main{padding:22px 22px 64px;min-width:0}
  @media (max-width:560px){ .main{padding:16px 14px 48px} }

  section{margin-bottom:22px}
  .sec-head{display:flex;align-items:center;gap:10px;margin-bottom:11px}
  .sec-head h2{margin:0;font-size:12px;font-weight:700;text-transform:uppercase;
    letter-spacing:.2em;font-family:var(--sans);color:var(--faint)}
  .sec-head .more{margin-left:auto}

  /* A surface is drawn with a rule, not a shadow — the house way. */
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r)}
  .pad{padding:18px 20px}

  .connect{padding:20px 22px;max-width:760px}
  .connect h2{margin:0 0 8px;font-size:15px}
  .connect p{margin:0 0 14px;font-size:12.5px;line-height:1.65;color:var(--dim)}
  .connect pre{background:var(--sunk);border:1px solid var(--line);border-radius:10px;
    padding:13px 15px;font-size:11.5px;line-height:1.6;overflow:auto;margin:0;
    font-family:var(--mono)}
  .connect-actions{display:flex;align-items:center;gap:10px;margin:14px 0 0;flex-wrap:wrap}
  .connect-actions #mcp-said{font-size:11.5px;color:var(--ok)}
  .connect-warn{margin:16px 0 0!important;padding:11px 13px;border-radius:9px;
    background:var(--warn-soft);color:var(--warn)}

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
    background:var(--on-tile-soft);font-family:var(--sans)}
  :root[data-theme="light"] .kpi.k3 .chip{background:rgb(255 255 255/14%)}
  .kpi .sub{font-size:12px;opacity:.78;margin-top:2px}
  .kpi .go{all:unset;cursor:pointer;margin-top:14px;align-self:flex-start;font-size:12px;
    font-weight:600;background:var(--on-tile-cta);padding:7px 14px;border-radius:99px;
    display:flex;align-items:center;gap:6px;color:inherit}
  :root[data-theme="light"] .kpi.k3 .go{background:rgb(255 255 255/13%)}
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
  .wf.off{opacity:.62}
  .wf-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .wf-name{all:unset;cursor:pointer;font-family:var(--mono);font-size:14px;font-weight:600}
  .wf-name:hover{text-decoration:underline}
  .tag{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
    padding:3px 8px;border-radius:7px;background:var(--sunk);color:var(--faint)}
  .tag.ok{background:var(--ok-soft);color:var(--ok)} .tag.warn{background:var(--warn-soft);color:var(--warn)}
  .tag.bad{background:var(--bad-soft);color:var(--bad)} .tag.go{background:var(--accent-soft);color:var(--accent)}
  .wf-actions{margin-left:auto;display:flex;gap:7px;flex-wrap:wrap}
  .wf-desc{color:var(--dim);font-size:13px;margin:7px 0 0}
  .wf-meta{color:var(--faint);font-size:11.5px;font-family:var(--mono);margin-top:10px;
    display:flex;gap:9px;flex-wrap:wrap;align-items:center}
  .wf-meta > * + *::before{content:"\\00B7";margin-right:9px;color:var(--line);font-weight:700}
  .runs{display:flex;gap:2px;align-items:center}
  /* Successes are the baseline and read quietly; a failure is what you are
     scanning for, so it keeps full strength and a little more room. */
  .runs i{width:4px;height:13px;border-radius:2px;background:var(--ok);opacity:.38}
  .runs i.bad{background:var(--bad);opacity:1;width:5px}
  .note{margin-top:11px;padding:10px 12px;border-radius:10px;font-size:12.5px;line-height:1.55}
  .note.warn{background:var(--warn-soft);color:var(--warn)}
  .note.bad{background:var(--bad-soft);color:var(--bad)}
  .note.info{background:var(--sunk);color:var(--dim)}

  /* ------------------------------------------------- one workflow ----- */
  /*
   * A workflow's own page, drawn as the pipeline it is: a rule down the left, a
   * numbered node per step, the boxes hanging off it. Read top to bottom here,
   * unlike the recorder's panel — this is the order replay runs them in, and a
   * page you arrive at cold should read forwards.
   */
  .back{all:unset;cursor:pointer;color:var(--faint);font-size:12.5px;margin-bottom:12px;
    display:inline-flex;align-items:center;gap:6px}
  .back:hover{color:var(--ink)}
  .steps{list-style:none;margin:16px 0 0;padding:0 0 0 30px;position:relative;
    display:flex;flex-direction:column;gap:10px}
  .steps::before{content:"";position:absolute;left:11px;top:14px;bottom:14px;width:2px;
    background:var(--line);border-radius:2px}
  .steps li{position:relative}
  .step-node{position:absolute;left:-30px;top:12px;display:grid;place-items:center;
    width:23px;height:23px;border-radius:50%;background:var(--accent);color:#fff;
    font-size:10.5px;font-weight:700;font-variant-numeric:tabular-nums}
  .step-box{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);
    padding:12px 15px}
  .step-row{display:grid;grid-template-columns:66px minmax(0,1fr);gap:12px;align-items:baseline;
    padding:2px 0}
  .step-k{font-size:9.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
    color:var(--faint)}
  .step-v{font-size:13px;overflow-wrap:anywhere}
  .step-val{margin:9px 0 0;padding:8px 10px;border-radius:8px;background:var(--sunk);
    font-family:var(--mono);font-size:11.5px;line-height:1.55;color:var(--ok);
    white-space:pre-wrap;overflow-wrap:anywhere;max-height:8em;overflow:auto}
  .step-val.dyn{color:var(--warn)}
  .step-val.none{color:var(--faint);font-family:var(--sans);font-style:italic}
  .step-health{margin-top:8px;font-size:11.5px;color:var(--faint)}
  .step-health.warn{color:var(--warn)} .step-health.bad{color:var(--bad)}
  .step-edit{margin-top:10px;display:flex;flex-direction:column;gap:8px}
  .seg{display:flex;border:1px solid var(--line);border-radius:9px;overflow:hidden;
    align-self:flex-start}
  .seg button{all:unset;cursor:pointer;padding:6px 13px;font-size:12px;color:var(--dim)}
  .seg button:hover{background:var(--sunk)}
  .seg button[aria-pressed="true"]{background:var(--ink);color:var(--page);font-weight:600}

  /* ---------------------------------------------------------- bits ---- */
  .btn{all:unset;cursor:pointer;font-size:12px;font-weight:550;padding:6px 13px;border-radius:9px;
    border:1px solid var(--line);color:var(--dim);background:var(--panel)}
  .btn:hover{color:var(--ink);border-color:var(--faint)}
  .btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
  .btn.primary:hover{filter:brightness(1.2)}
  .btn:disabled{opacity:.45;cursor:default}
  .btn.danger{color:var(--bad);border-color:transparent}
  .btn.danger:hover{border-color:var(--bad);background:var(--bad-soft)}
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
  .field label{display:block;font-size:10.5px;font-weight:700;letter-spacing:.11em;
    text-transform:uppercase;color:var(--faint);margin-bottom:6px}
  .field textarea,.field input{width:100%;font:inherit;font-size:13px;padding:10px 12px;
    border-radius:10px;border:1px solid var(--line);background:var(--sunk);
    color:var(--ink);line-height:1.55}
  .field textarea{min-height:88px;resize:vertical}
  .field textarea:focus,.field input:focus{outline:2px solid var(--accent);outline-offset:-1px}
  .newproj{display:flex;gap:8px;flex-wrap:wrap}
  .newproj input{flex:1;min-width:180px;font:inherit;font-size:13px;padding:8px 12px;
    border-radius:9px;border:1px solid var(--line);background:var(--sunk);color:var(--ink)}
  .hint{font-size:12px;color:var(--faint);margin:10px 0 0;line-height:1.55}

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
  dialog{border:0;padding:0;background:transparent;max-width:min(1080px,94vw);width:100%;
    max-height:92vh}
  dialog::backdrop{background:rgb(8 10 14/72%);backdrop-filter:blur(3px)}
  /*
   * minmax(0, …) and min-height:0 are both load-bearing, for the same reason.
   * A grid item defaults to min-height:auto, so it refuses to shrink below its
   * content — which means overflow:auto on the metadata column never engages
   * and the parent's max-height just clips it. On a short window that put the
   * bottom of the image below the bottom of the dialog and made the Save button
   * unreachable, with nothing to scroll.
   */
  .viewer{background:var(--panel);border-radius:var(--r);overflow:hidden;display:grid;
    grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr);
    max-height:88vh;min-height:min(360px,70vh)}
  .viewer .stage{background:var(--sunk);position:relative;padding:18px;min-height:0;
    overflow:hidden}
  /*
   * Absolutely positioned and letterboxed, rather than max-height:100%. A
   * percentage max-height resolves against the grid area, which is itself
   * auto-sized from the content — circular, so the browser drops it and a tall
   * image renders at full height inside a short box. object-fit:contain on a
   * definitely-sized element has no such circularity.
   */
  .viewer .stage img{position:absolute;inset:18px;width:calc(100% - 36px);
    height:calc(100% - 36px);object-fit:contain;border-radius:8px}
  .viewer .meta{padding:20px;display:flex;flex-direction:column;gap:14px;min-height:0;overflow:auto}
  /* Stacked, the whole panel scrolls as one rather than two nested scrollers. */
  @media (max-width:760px){
    .viewer{grid-template-columns:1fr;grid-template-rows:auto auto;max-height:92vh;overflow:auto}
    .viewer .stage{min-height:180px;display:grid;place-items:center}
    .viewer .stage img{position:static;inset:auto;width:auto;height:auto;
      max-width:100%;max-height:46vh}
    .viewer .meta{overflow:visible}
  }
  .viewer h3{margin:0;font-size:15px}
  .field p{margin:0;font-size:12.5px;color:var(--dim);line-height:1.6;white-space:pre-wrap;
    word-break:break-word}
  /*
   * A prompt can be four hundred words of style guide. Left to run, it makes the
   * metadata column the tallest thing in the dialog, the stage grows to match,
   * and a wide image ends up marooned in the middle of a very tall box — which
   * is what "the image is at the bottom" actually was. It gets its own scroller
   * so the panel stays a sensible height and the whole text is still there.
   */
  #v-prompt{max-height:8.5rem;overflow:auto;padding-right:6px}
  #v-prompt::-webkit-scrollbar{width:5px}
  #v-prompt::-webkit-scrollbar-thumb{background:var(--line);border-radius:3px}
  .field p.none{color:var(--faint);font-style:italic}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:12px;font-family:var(--mono);
    color:var(--dim)}
  .kv b{color:var(--faint);font-weight:500}
  .viewer .foot{display:flex;gap:8px;align-items:center;margin-top:auto;padding:12px 0 0;
    position:sticky;bottom:-20px;background:var(--panel);flex-wrap:wrap}
  .viewer .foot .danger{margin-left:auto}
  .saved{font-size:12px;color:var(--ok);opacity:0;transition:opacity .2s}
  .saved.on{opacity:1}

  /* ----------------------------------------------------------- ask ---- */
  /*
   * The dashboard's own confirm. The browser's cannot be styled, blocks the
   * event loop that the live stream runs on, and reads as though the *page* is
   * asking at the moment the question is about what you just pressed.
   *
   * It is a real dialog, opened with showModal, and that is load-bearing rather
   * than tidy. The asset viewer is a modal dialog, so everything outside it is
   * inert and in a layer beneath it — a plain positioned div asking "delete
   * this?" rendered perfectly, sat under the viewer's backdrop, and swallowed
   * every click aimed at it. Only the top layer is above the top layer.
   */
  #ask{width:min(440px,100%);max-width:min(440px,94vw);padding:0;background:transparent}
  #ask::backdrop{background:rgb(0 0 0/56%)}
  .ask-card{width:100%;padding:22px;border-radius:14px;background:var(--panel);
    border:1px solid var(--line);box-shadow:0 24px 70px rgb(0 0 0/45%);
    display:flex;flex-direction:column;gap:12px}
  .ask-card h3{margin:0;font-size:16px}
  .ask-card p{margin:0;font-size:12.5px;line-height:1.6;color:var(--dim)}
  .ask-card .actions{display:flex;gap:8px;align-items:center}
  .ask-card input{width:100%;font:inherit;font-size:13px;padding:9px 12px;border-radius:9px;
    border:1px solid var(--line);background:var(--sunk);color:var(--ink)}

  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand">
      <span class="glyph">A</span>
      <b>Atelier</b>
    </div>

    <nav class="nav" id="nav" role="tablist" aria-label="Sections">
      <button role="tab" id="tab-overview" data-tab="overview" aria-controls="panel-overview">
        <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/></svg>
        <span class="label-text">Overview</span>
      </button>
      <button role="tab" id="tab-workflows" data-tab="workflows" aria-controls="panel-workflows">
        <svg viewBox="0 0 24 24"><path d="M5 6h14M5 12h9M5 18h5"/><circle cx="19" cy="16" r="3"/></svg>
        <span class="label-text">Workflows</span><span class="badge" id="badge-workflows" hidden></span>
      </button>
      <button role="tab" id="tab-runs" data-tab="runs" aria-controls="panel-runs">
        <svg viewBox="0 0 24 24"><path d="M4 18V9M9.5 18V5M15 18v-6M20.5 18v-9"/></svg>
        <span class="label-text">Runs</span><span class="badge" id="badge-runs" hidden></span>
      </button>
      <button role="tab" id="tab-assets" data-tab="assets" aria-controls="panel-assets">
        <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 4.5-4.5 3.5 3.5 3-3L20 18"/></svg>
        <span class="label-text">Assets</span>
      </button>
      <button role="tab" id="tab-connect" data-tab="connect" aria-controls="panel-connect">
        <svg viewBox="0 0 24 24"><path d="M9 17H7a5 5 0 0 1 0-10h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8"/></svg>
        <span class="label-text">Connect</span>
      </button>
    </nav>

    <p class="side-version">v${version}</p>
  </aside>

  <div class="wrap">
    <header class="head">
      <button class="hbtn" id="drawer" type="button" aria-label="Show or hide the menu">
        <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
      <div style="min-width:0">
        <h1 id="page-title">Overview</h1>
        <div class="sub" id="page-sub">A little of everything</div>
      </div>

      <div class="head-right">
        <button class="hbtn" id="theme" type="button" aria-label="Switch between light and dark">
          <svg class="moon" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>
          <svg class="sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2 12h2.4M19.6 12H22M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/></svg>
        </button>
        <button class="hlink" id="tab-projects" data-tab="projects" type="button">
          <svg viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l1.8 2.2h8A2.5 2.5 0 0 1 21 9.7v7.8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>
          <span>Projects</span>
        </button>
        <div class="switcher">
          <button id="proj-btn" aria-haspopup="listbox" aria-expanded="false">
            <span class="proj-dot"></span>
            <span class="proj-name" id="proj-name">…</span>
            <span class="proj-caret">&#9662;</span>
          </button>
          <ul class="proj-menu" id="proj-menu" role="listbox" hidden></ul>
        </div>
      </div>
    </header>

    <main class="main">
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

      <!-- One workflow, in full. Reached from any name on the page, and from
           the extension popup, which links straight here. -->
      <div role="tabpanel" id="panel-workflow" hidden>
        <div id="workflow-one"></div>
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

      <div role="tabpanel" id="panel-projects" aria-labelledby="tab-projects" hidden>
        <section class="card pad">
          <div class="sec-head"><h2>New project</h2></div>
          <form class="newproj" id="proj-form">
            <input id="proj-input" placeholder="Acme redesign" autocomplete="off" aria-label="Project name">
            <button class="btn primary" type="submit">Create</button>
          </form>
          <p class="hint">It gets its own MCP token, so connecting an agent to it is a copy rather
            than a decision. Nothing moves into it, and neither this page nor an agent session
            switches to it.</p>
        </section>
        <div id="projects"></div>
      </div>

      <div role="tabpanel" id="panel-connect" aria-labelledby="tab-connect" hidden>
        <section class="card connect">
          <h2>Point an agent at <span id="mcp-project">this project</span></h2>
          <p>
            Save this as <code>.mcp.json</code> beside a repository and Claude Code has these tools,
            with no copy of Atelier on that machine and nothing to build. The token in it belongs to
            this project alone, so the agent is working here from its first call and never has to be
            told where it is.
          </p>
          <pre id="mcp-json">…</pre>
          <div class="connect-actions">
            <button class="btn" id="mcp-copy">Copy</button>
            <a class="btn" id="mcp-download" href="/mcp.json" download=".mcp.json">Download</a>
            <button class="btn danger" id="mcp-rotate">Issue a new token</button>
            <span id="mcp-said"></span>
          </div>
          <p class="connect-warn">
            This token is the key to everything the daemon can do to a browser, inside this project.
            Treat it the way you would treat a password — it does not belong in a repo.
            Issuing a new one stops every config file carrying the old one from working.
          </p>
        </section>
      </div>
    </main>
  </div>
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
        <!-- Pushed to the far end and drawn as a danger, because it is the one
             control here that cannot be undone. -->
        <button class="btn danger" id="v-delete">Delete</button>
      </div>
    </div>
  </div>
</dialog>

<dialog id="ask"><div class="ask-card" id="ask-card"></div></dialog>

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
const kb = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'kB'

/* --------------------------------------------------------------- ask --- */

/**
 * The page's own confirm and prompt.
 *
 * The browser's block the event loop the live stream runs on, cannot be
 * styled, and read as though the site is asking — at the exact moment the
 * question is about the button just pressed.
 */
function ask(opts) {
  const card = $('ask-card')
  card.innerHTML = '<h3>' + esc(opts.title) + '</h3>' +
    (opts.body ? '<p>' + esc(opts.body) + '</p>' : '') +
    (opts.field ? '<input id="ask-input" value="' + esc(opts.field.value || '') + '" ' +
      'placeholder="' + esc(opts.field.placeholder || '') + '">' : '') +
    '<div class="actions"><button class="btn ' + (opts.danger ? 'danger' : 'primary') + '" id="ask-go">' +
    esc(opts.confirm) + '</button>' +
    (opts.quiet ? '' : '<button class="btn" id="ask-stop">Cancel</button>') + '</div>'
  $('ask').showModal()
  const input = $('ask-input')
  if (input) { input.focus(); input.select() }
  const go = () => { $('ask').close(); opts.onConfirm && opts.onConfirm(input ? input.value : undefined) }
  $('ask-go').onclick = go
  if (input) input.onkeydown = (e) => { if (e.key === 'Enter') go() }
  if ($('ask-stop')) $('ask-stop').onclick = () => $('ask').close()
}
const tell = (title, body) => ask({ title, body, confirm: 'OK', quiet: true })

/* -------------------------------------------------------------- tabs --- */

const TABS = ['overview', 'workflows', 'runs', 'assets', 'projects', 'connect', 'workflow']
const TITLES = {
  overview: ['Overview', 'A little of everything, so the first screen answers the question'],
  workflows: ['Workflows', 'What this project can do, and whether it still can'],
  runs: ['Runs', 'What has run, and how it went'],
  assets: ['Assets', 'What the workflows produced'],
  projects: ['Projects', 'Separate bodies of work. Workflows, runs and assets belong to exactly one'],
  connect: ['Connect', 'Point an agent at this project — the config, and the token in it'],
  workflow: ['Workflow', 'Every step, in the order replay runs them'],
}

/* Held outside render(), which runs on every state frame and every 25s
   regardless. Deriving the visible tab from the data would snap the page back
   under the reader mid-sentence. */
let currentTab = 'overview'
/* Which workflow the workflow tab is showing, by name — in the URL, so the
   extension popup can link straight to one. */
let openWorkflow = null
let latest = null

/* The .mcp.json is fetched rather than rendered into the page, so no token sits
   in the HTML of every tab the dashboard is left open in. Declared up here with
   the other page state because applyTab() reads it. */
let mcpText = null
let mcpFor = null

function readHash() {
  const raw = decodeURIComponent(location.hash.slice(1))
  if (raw.indexOf('workflow/') === 0) {
    openWorkflow = raw.slice('workflow/'.length)
    return 'workflow'
  }
  openWorkflow = null
  return TABS.indexOf(raw) >= 0 && raw !== 'workflow' ? raw : 'overview'
}

function applyTab() {
  // Only when the reader asks for it: the config carries a credential and there
  // is no reason to fetch one to render a tab nobody opened.
  if (currentTab === 'connect') loadMcpConfig()

  for (const t of TABS) {
    const tab = $('tab-' + t), panel = $('panel-' + t)
    if (panel) panel.hidden = t !== currentTab
    if (!tab) continue
    const on = t === currentTab
    tab.setAttribute('aria-selected', on ? 'true' : 'false')
    tab.tabIndex = on ? 0 : -1
  }
  $('page-title').textContent = currentTab === 'workflow' && openWorkflow ? openWorkflow : TITLES[currentTab][0]
  $('page-sub').textContent = TITLES[currentTab][1]
  if (currentTab === 'workflow' && latest) renderWorkflowPage()
}

function goTab(t, opts) {
  if (TABS.indexOf(t) < 0) return
  currentTab = t
  if (t !== 'workflow') openWorkflow = null
  const want = t === 'workflow' ? 'workflow/' + encodeURIComponent(openWorkflow) : t
  if (decodeURIComponent(location.hash.slice(1)) !== want) history.replaceState(null, '', '#' + want)
  applyTab()
  if (opts && opts.focus && $('tab-' + t)) $('tab-' + t).focus()
}

function goWorkflow(name) {
  openWorkflow = name
  goTab('workflow')
}

function setBadge(tab, n, tone) {
  const el = $('badge-' + tab)
  if (!el) return
  el.hidden = !n
  el.textContent = String(n)
  el.className = 'badge' + (tone ? ' ' + tone : '')
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]')
  if (t) goTab(t.dataset.tab)
})

/* The sidebar is a tablist, so the arrow keys walk it. The Projects link lives
   in the header and is reached the ordinary way, by tabbing to it. */
const NAV = ['overview', 'workflows', 'runs', 'assets', 'connect']
$('nav').addEventListener('keydown', (e) => {
  const i = NAV.indexOf(currentTab)
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') goTab(NAV[(i + 1) % NAV.length], { focus: true })
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') goTab(NAV[(i - 1 + NAV.length) % NAV.length], { focus: true })
  else if (e.key === 'Home') goTab(NAV[0], { focus: true })
  else if (e.key === 'End') goTab(NAV[NAV.length - 1], { focus: true })
  else return
  e.preventDefault()
})

window.addEventListener('hashchange', () => { currentTab = readHash(); applyTab() })
currentTab = readHash()
applyTab()

/* ------------------------------------------------------------ drawer --- */

/* The attribute is already set by the head script when a choice was remembered;
   absent means open, which is the default rather than a stored value. */
$('drawer').onclick = () => {
  const closed = document.documentElement.dataset.drawer === 'closed'
  if (closed) delete document.documentElement.dataset.drawer
  else document.documentElement.dataset.drawer = 'closed'
  try { localStorage.setItem('atelier:drawer', closed ? 'open' : 'closed') } catch (e) {}
}

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

function stateTagFor(w) {
  const health = w.health || { state: 'unknown' }
  if (w.status === 'draft') return '<span class="tag go">awaiting you</span>'
  if (w.status === 'disabled') return '<span class="tag">disabled</span>'
  if (health.state === 'fragile') return '<span class="tag bad">fragile</span>'
  if (health.state === 'degraded') return '<span class="tag warn">degrading</span>'
  if (health.state === 'ok') return '<span class="tag ok">healthy</span>'
  return '<span class="tag">not run yet</span>'
}

function toneFor(w) {
  if (w.status === 'disabled') return 'off'
  if (w.status === 'draft') return 'pending'
  const state = (w.health && w.health.state) || 'unknown'
  return state === 'unknown' ? '' : state
}

function workflowCard(w) {
  const health = w.health || { state: 'unknown', summary: '', degraded: [] }

  // At most one note per card. Two stacked explanations is a paragraph.
  let note = ''
  if (w.status === 'draft') note = '<div class="note info">Recorded and written up. Nothing runs until you activate it.</div>'
  else if (w.status === 'disabled') note = '<div class="note info">Turned off. It keeps its steps and its history, and no agent can see it.</div>'
  else if (health.state === 'fragile' || health.state === 'degraded') {
    const worst = (health.degraded || [])[0]
    note = '<div class="note ' + (health.state === 'fragile' ? 'bad' : 'warn') + '">' +
      esc(health.summary) + (worst ? '<br>' + esc(worst.note) + ' — repoint that step from the Atelier popup.' : '') + '</div>'
  }

  return '<article class="wf ' + toneFor(w) + '"><div class="wf-top">' +
    '<button class="wf-name" data-open="' + esc(w.name) + '">' + esc(w.name) + '</button>' +
    '<span class="tag">' + esc(w.produces) + '</span>' + stateTagFor(w) +
    '<span class="wf-actions">' +
    '<button class="btn" data-open="' + esc(w.name) + '">Open</button>' +
    '</span></div>' +
    '<p class="wf-desc">' + esc(w.description) + '</p>' +
    '<div class="wf-meta"><span>' + plural(w.steps, 'step') + '</span>' +
    '<span>' + esc((w.origins || []).join(', ')) + '</span>' + runStrip(w.runs) + '</div>' +
    note + '</article>'
}

function assetCard(a) {
  const what = a.description
    ? '<b>' + esc(a.description) + '</b>'
    : '<b class="none">No description yet</b>'
  return '<button class="asset" data-asset="' + esc(a.id) + '">' +
    (a.mime.indexOf('image/') === 0
      ? '<img class="thumb" loading="lazy" src="/asset/' + a.id + '" alt="">'
      : '<span class="thumb"></span>') +
    '<span class="cap">' + what +
    '<span>' + (a.width ? a.width + '×' + a.height : kb(a.bytes)) + ' · ' + ago(a.createdAt) + '</span>' +
    '</span></button>'
}

/* ------------------------------------------------------ one workflow --- */

const ACTION_WORDS = {
  navigate: 'Open the page',
  click: 'Click it',
  type: 'Type text into it',
  select: 'Choose an option',
  check: 'Tick it',
  uncheck: 'Untick it',
  key: 'Press a key',
  scroll: 'Scroll to it',
  manual: 'Stop and hand over the keyboard',
}

function actionWords(step) {
  if (step.kind === 'capture') {
    if (step.capture && step.capture.from === 'placeholder') return 'Capture its placeholder'
    return (step.capture && step.capture.as) === 'text' ? 'Capture its text' : 'Capture the image or file it holds'
  }
  if (step.kind === 'wait') return step.note && step.note.indexOf('to go') > 0 ? 'Wait until it goes away' : 'Wait until it appears'
  if (step.kind === 'type' && step.valueMode === 'static' && step.sampleValue === '') return 'Clear it'
  return ACTION_WORDS[step.kind] || step.kind
}

/** Which step's value is open for editing, by id. */
let editingStep = null

function renderWorkflowPage() {
  const host = $('workflow-one')
  const w = (latest.workflows || []).filter(x => x.name === openWorkflow)[0]
  if (!w) {
    host.innerHTML = '<div class="empty"><b>No workflow called ' + esc(openWorkflow || '') + '</b>' +
      'It may belong to another project, or it may have been deleted.</div>'
    return
  }

  const health = w.health || { steps: [], summary: '', state: 'unknown' }
  const byStep = {}
  for (const s of health.steps || []) byStep[s.stepId] = s

  const inputs = (w.inputs || []).length
    ? (w.inputs || []).map(i => '<code>' + esc(i.name) + '</code>').join(' ')
    : '<span style="color:var(--faint)">nothing — it types only what it was recorded with</span>'

  const steps = (w.stepList || []).map((step, i) => {
    const h = byStep[step.id]
    const tone = h && (h.state === 'fragile' ? 'bad' : h.state === 'degraded' ? 'warn' : '')
    let value = ''
    if (step.kind === 'type' || step.kind === 'select') {
      value = editingStep === step.id ? stepEditor(w, step) : stepValue(step)
    }
    return '<li><span class="step-node">' + (i + 1) + '</span><div class="step-box">' +
      '<div class="step-row"><span class="step-k">Target</span>' +
      '<span class="step-v">' + esc(step.target || (step.kind === 'navigate' ? 'the page' : '—')) + '</span></div>' +
      '<div class="step-row"><span class="step-k">Action</span>' +
      '<span class="step-v">' + esc(actionWords(step)) + '</span></div>' +
      value +
      (h ? '<div class="step-health ' + tone + '">' + esc(h.detail) + '</div>' : '') +
      '</div></li>'
  }).join('')

  const actions =
    (w.status === 'draft' ? '<button class="btn primary" data-activate="' + esc(w.name) + '">Activate</button>' : '') +
    (w.status !== 'disabled' ? '<button class="btn" data-test="' + esc(w.name) + '">Test run</button>' : '') +
    (w.status === 'active' ? '<button class="btn" data-status="disabled" data-name="' + esc(w.name) + '">Disable</button>' : '') +
    (w.status === 'disabled' ? '<button class="btn primary" data-status="active" data-name="' + esc(w.name) + '">Enable</button>' : '') +
    '<button class="btn danger" data-delete="' + esc(w.name) + '">Delete</button>'

  host.innerHTML =
    '<button class="back" data-goto="workflows">&larr; All workflows</button>' +
    '<article class="wf ' + toneFor(w) + '"><div class="wf-top">' +
    '<span class="wf-name" style="cursor:default">' + esc(w.name) + '</span>' +
    '<span class="tag">' + esc(w.produces) + '</span>' + stateTagFor(w) +
    '<span class="wf-actions">' + actions + '</span></div>' +
    '<p class="wf-desc">' + esc(w.description) + '</p>' +
    '<div class="wf-meta"><span>' + plural(w.steps, 'step') + '</span>' +
    '<span>' + esc((w.origins || []).join(', ')) + '</span>' + runStrip(w.runs) + '</div>' +
    (health.summary ? '<div class="note info">' + esc(health.summary) + '</div>' : '') +
    '</article>' +
    '<div class="card pad" style="margin-bottom:14px"><div class="sec-head"><h2>The agent passes</h2></div>' +
    inputs + '</div>' +
    '<div class="sec-head"><h2>Steps</h2></div>' +
    (steps ? '<ol class="steps">' + steps + '</ol>' : '<div class="empty">This workflow has no steps.</div>') +
    '<p class="hint">A step\\'s action is what the person recording performed, so it is not editable —' +
    ' only its value is. To change where a step looks, repoint it from the Atelier popup.</p>'
}

function stepValue(step) {
  if (step.valueMode === 'dynamic') {
    return '<div class="step-val dyn">{{' + esc(step.inputName || '') + '}} — the agent supplies it.' +
      ' A test run types: ' + esc(step.sampleValue || '(nothing)') + '</div>' +
      '<button class="btn" style="margin-top:9px" data-edit="' + esc(step.id) + '">Change this value</button>'
  }
  const body = step.sampleValue === ''
    ? '<div class="step-val none">empties the field</div>'
    : '<div class="step-val">' + esc(step.sampleValue || '') + '</div>'
  return body + '<button class="btn" style="margin-top:9px" data-edit="' + esc(step.id) + '">Change this value</button>'
}

/* Held between renders, because the live stream redraws this page underneath
   whatever is being typed into it. */
let editMode = null

function stepEditor(w, step) {
  const mode = editMode || step.valueMode || 'static'
  return '<div class="step-edit">' +
    '<div class="seg">' +
    '<button data-mode="static" aria-pressed="' + (mode === 'static') + '">Always this</button>' +
    '<button data-mode="dynamic" aria-pressed="' + (mode === 'dynamic') + '">The agent supplies it</button>' +
    '</div>' +
    '<div class="field"><label for="sv">' +
    (mode === 'dynamic' ? 'What a test run types' : 'Text to type') + '</label>' +
    '<textarea id="sv">' + esc(step.sampleValue || '') + '</textarea></div>' +
    (mode === 'dynamic'
      ? '<div class="field"><label for="iv">The agent passes it as</label>' +
        '<input id="iv" value="' + esc(step.inputName || '') + '"></div>'
      : '<p class="hint">Replayed exactly. The agent never sees this text and it is not one of the workflow\\'s inputs.</p>') +
    '<div class="actions" style="display:flex;gap:8px">' +
    '<button class="btn primary" data-save-step="' + esc(step.id) + '" data-wf="' + esc(w.name) + '">Save</button>' +
    '<button class="btn" data-cancel-step="1">Cancel</button></div></div>'
}

/* ------------------------------------------------------------ render --- */

function render(d) {
  latest = d
  const blocked = d.jobs.filter(j => j.status === 'blocked')
  const active = d.jobs.filter(j => j.status === 'running' || j.status === 'queued')
  const attached = d.browsers.length > 0
  const decaying = (d.unhealthy || []).length
  const toActivate = (d.pendingActivation || []).length

  /* -- attention: only what is true, and never twice ------------------- */
  const cards = []
  for (const j of blocked) {
    cards.push('<div class="wf fragile" style="margin-bottom:14px"><div class="wf-top">' +
      '<span class="wf-name" style="cursor:default">' + esc(j.workflowName) + '</span>' +
      '<span class="tag bad">paused</span></div>' +
      '<p class="wf-desc">' + esc(j.blockedReason || 'Paused.') + ' Resume it from the Atelier popup.</p></div>')
  }
  if (!attached) {
    cards.push('<div class="wf" style="margin-bottom:14px;border-color:var(--warn)"><div class="wf-top">' +
      '<span class="wf-name" style="cursor:default">No browser attached</span><span class="tag warn">connect</span></div>' +
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
          '<button class="k" style="all:unset;cursor:pointer;flex:1 1 auto;min-width:7ch;font-family:var(--mono);font-size:12.5px" data-open="' + esc(w.name) + '">' + esc(w.name) + '</button>' +
          '<span class="when">' + ((w.runs && w.runs.total) ? plural(w.runs.total, 'run') + ' · ' + ago(w.runs.lastAt) : 'never run') + '</span></div>'
      }).join('')
    : '<div style="color:var(--faint);font-size:13px">Nothing recorded yet.</div>'

  $('ov-assets').innerHTML = d.assets.length
    ? '<div class="strip">' + d.assets.slice(0, 10).map((a) =>
        '<button data-asset="' + esc(a.id) + '" title="' + esc(a.description || a.prompt || '') + '">' +
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
    '<article class="wf"><div class="wf-top"><span class="wf-name" style="cursor:default">' + esc(j.workflowName) + '</span>' +
    (j.isTest ? '<span class="tag">test run</span>' : '') +
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

  /* -- projects ---------------------------------------------------------- */
  const projects = d.projects || []
  // Not named active: that is already the list of running jobs in this function.
  const here = d.activeProject
  $('proj-name').textContent = here ? here.name : '—'

  $('proj-menu').innerHTML = projects.map(p =>
    '<li><button role="option" data-switch="' + esc(p.id) + '"' +
    (here && p.id === here.id ? ' aria-selected="true"' : '') + '>' +
    esc(p.name) +
    '<span class="meta">' + p.contents.workflows + ' workflows · ' + p.contents.assets + ' assets</span>' +
    '</button></li>').join('')

  $('projects').innerHTML = projects.map(p => {
    const c = p.contents
    const isHere = here && p.id === here.id
    const empty = c.workflows + c.jobs + c.assets + c.drafts === 0
    return '<article class="wf' + (isHere ? ' pending' : '') + '"><div class="wf-top">' +
      '<span class="wf-name" style="cursor:default">' + esc(p.slug) + '</span>' +
      (isHere ? '<span class="tag go">showing</span>' : '') +
      '<span class="wf-actions">' +
      (isHere ? '' : '<button class="btn" data-switch="' + esc(p.id) + '">Switch to</button>') +
      '<button class="btn" data-rename="' + esc(p.id) + '">Rename</button>' +
      // Only offered when it is actually possible: a button that always
      // refuses teaches people to ignore buttons.
      (!isHere && empty && projects.length > 1
        ? '<button class="btn danger" data-delproj="' + esc(p.id) + '">Delete</button>' : '') +
      '</span></div>' +
      '<p class="wf-desc">' + esc(p.name) + (p.note ? ' — ' + esc(p.note) : '') + '</p>' +
      '<div class="wf-meta"><span>' + plural(c.workflows, 'workflow') + '</span>' +
      '<span>' + plural(c.jobs, 'run') + '</span>' +
      '<span>' + plural(c.assets, 'asset') + '</span>' +
      '<span>' + plural(c.drafts, 'recording') + '</span></div>' +
      (empty || isHere ? '' :
        '<div class="note info">Holds work, so it cannot be deleted until that is moved or removed.</div>') +
      '</article>'
  }).join('')

  if ($('mcp-project')) $('mcp-project').textContent = here ? here.name : 'this project'
  // The config belongs to whichever project is on screen, so switching project
  // has to throw the fetched one away rather than show the wrong token.
  if (here && mcpFor && mcpFor !== here.id) { mcpText = null; mcpFor = null; if (currentTab === 'connect') loadMcpConfig() }

  if (currentTab === 'workflow') renderWorkflowPage()

  // A viewer left open must follow the data, or it shows a stale description
  // the moment anything else edits one.
  if ($('viewer').open && openAsset != null) {
    const fresh = d.assets.filter(a => a.id === openAsset)[0]
    // Deleted from somewhere else — another tab, or an agent. Do not sit there
    // showing an asset that no longer exists.
    if (fresh) fillViewer(fresh)
    else $('viewer').close()
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
$('v-delete').onclick = () => {
  if (!openAsset) return
  const a = latest && latest.assets.filter(x => x.id === openAsset)[0]
  const what = a && a.description ? '\\u201c' + a.description.slice(0, 60) + '\\u201d' : 'this asset'
  // The bytes are gone for good, and saying so is the honest way to ask.
  ask({
    title: 'Delete ' + what + '?',
    body: 'The file is removed and cannot be recovered.',
    confirm: 'Delete it',
    danger: true,
    onConfirm: async () => {
      try {
        await post('/api/assets.delete', { id: openAsset })
        $('viewer').close()
      } catch (e) { tell('Could not delete', e.message) }
    },
  })
}
$('v-open').onclick = () => { if (openAsset) window.open('/asset/' + openAsset, '_blank') }
$('v-save').onclick = async () => {
  if (!openAsset) return
  $('v-save').disabled = true
  try {
    await post('/api/assets.describe', { id: openAsset, description: $('v-desc').value })
    $('v-saved').className = 'saved on'
    setTimeout(() => { $('v-saved').className = 'saved' }, 1800)
  } catch (e) {
    tell('Could not save', e.message)
  } finally {
    $('v-save').disabled = false
  }
}
// Clicking the backdrop closes, which is what everyone expects of a lightbox.
$('viewer').addEventListener('click', (e) => { if (e.target === $('viewer')) $('viewer').close() })
$('viewer').addEventListener('close', () => { openAsset = null })

/* ------------------------------------------------------------- theme --- */

/* The attribute is already set by the head script when a choice was remembered;
   absent means dark, which is the default rather than a stored value. The
   button shows the theme you would get, not the one you are in. */
$('theme').onclick = () => {
  const dark = document.documentElement.dataset.theme !== 'light'
  document.documentElement.dataset.theme = dark ? 'light' : 'dark'
  try { localStorage.setItem('atelier:theme', dark ? 'light' : 'dark') } catch (e) {}
}

/* ----------------------------------------------------------- connect --- */

async function loadMcpConfig() {
  const here = latest && latest.activeProject
  if (mcpText !== null && (!here || mcpFor === here.id)) return
  try {
    const res = await fetch('/mcp.json' + (here ? '?project=' + encodeURIComponent(here.id) : ''))
    mcpText = JSON.stringify(await res.json(), null, 2)
    mcpFor = here ? here.id : null
  } catch (e) {
    mcpText = 'Could not read the config — is the daemon still running?'
  }
  $('mcp-json').textContent = mcpText
  $('mcp-download').href = '/mcp.json' + (here ? '?project=' + encodeURIComponent(here.id) : '')
}

$('mcp-copy').onclick = async () => {
  await loadMcpConfig()
  try {
    await navigator.clipboard.writeText(mcpText)
    said('Copied')
  } catch (e) {
    /* A denied clipboard is not an error worth a dialog: the text is on screen
       and Download is right there. */
    said('Select the text above, or use Download')
  }
}

$('mcp-rotate').onclick = () => {
  const here = latest && latest.activeProject
  if (!here) return
  ask({
    title: 'Issue a new token for ' + here.name + '?',
    body: 'Every .mcp.json carrying the old one stops working immediately, and every agent using it ' +
      'loses access until it is given the new file. This is the only way to revoke one.',
    confirm: 'Issue a new token',
    danger: true,
    onConfirm: async () => {
      try {
        await post('/api/projects.rotateToken', { id: here.id })
        mcpText = null; mcpFor = null
        await loadMcpConfig()
        said('New token issued')
      } catch (e) { tell('Could not issue one', e.message) }
    },
  })
}

function said(message) {
  $('mcp-said').textContent = message
  setTimeout(() => { $('mcp-said').textContent = '' }, 2500)
}

/* ---------------------------------------------------------- projects --- */

const closeMenu = () => {
  $('proj-menu').hidden = true
  $('proj-btn').setAttribute('aria-expanded', 'false')
}
$('proj-btn').onclick = (e) => {
  e.stopPropagation()
  const willOpen = $('proj-menu').hidden
  $('proj-menu').hidden = !willOpen
  $('proj-btn').setAttribute('aria-expanded', String(willOpen))
}
document.addEventListener('click', () => closeMenu())
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu() })

$('proj-form').onsubmit = async (e) => {
  e.preventDefault()
  const name = $('proj-input').value.trim()
  if (!name) return
  try {
    await post('/api/projects.create', { name })
    $('proj-input').value = ''
  } catch (err) {
    tell('Could not create it', err.message)
  }
}

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
  const open = e.target.closest('[data-open]')
  if (open) return goWorkflow(open.dataset.open)

  const sw = e.target.closest('[data-switch]')
  if (sw) {
    closeMenu()
    // Switching is the whole frame changing, so it is worth being explicit that
    // this moves the page and not any agent session already working elsewhere.
    try { await post('/api/projects.activate', { id: sw.dataset.switch }) }
    catch (err) { tell('Could not switch', err.message) }
    return
  }

  const rn = e.target.closest('[data-rename]')
  if (rn) {
    const current = (latest.projects.filter(p => p.id === rn.dataset.rename)[0] || {}).name || ''
    return ask({
      title: 'Rename this project',
      body: 'Nothing inside it moves, and its token is unchanged.',
      field: { value: current },
      confirm: 'Rename',
      onConfirm: async (name) => {
        if (!name || name === current) return
        try { await post('/api/projects.rename', { id: rn.dataset.rename, name }) }
        catch (err) { tell('Could not rename it', err.message) }
      },
    })
  }

  const dp = e.target.closest('[data-delproj]')
  if (dp) {
    const p = latest.projects.filter(x => x.id === dp.dataset.delproj)[0]
    return ask({
      title: 'Delete ' + (p ? p.name : 'this project') + '?',
      body: 'It is empty, so nothing is lost. Its token stops working.',
      confirm: 'Delete it',
      danger: true,
      onConfirm: async () => {
        try { await post('/api/projects.delete', { id: dp.dataset.delproj }) }
        catch (err) { tell('Could not delete it', err.message) }
      },
    })
  }

  const goto = e.target.closest('[data-goto]')
  if (goto) return goTab(goto.dataset.goto)

  const asset = e.target.closest('[data-asset]')
  if (asset && latest) {
    // By id, never by position. The grid is rebuilt on every state frame, so an
    // index captured at render time can point at a different asset by the time
    // it is clicked — which was survivable when the only thing you could do was
    // look, and is not now that one of the buttons deletes.
    const found = latest.assets.filter(a => a.id === asset.dataset.asset)[0]
    if (found) openViewer(found)
    return
  }

  /* -- one workflow ----------------------------------------------------- */

  const mode = e.target.closest('[data-mode]')
  if (mode) { editMode = mode.dataset.mode; return renderWorkflowPage() }

  const edit = e.target.closest('[data-edit]')
  if (edit) { editingStep = edit.dataset.edit; editMode = null; return renderWorkflowPage() }

  if (e.target.closest('[data-cancel-step]')) {
    editingStep = null; editMode = null
    return renderWorkflowPage()
  }

  const saveStep = e.target.closest('[data-save-step]')
  if (saveStep) {
    const body = {
      name: saveStep.dataset.wf,
      stepId: saveStep.dataset.saveStep,
      valueMode: editMode || undefined,
      sampleValue: $('sv') ? $('sv').value : undefined,
      inputName: $('iv') ? $('iv').value : undefined,
    }
    try {
      await post('/api/workflows.setStepValue', body)
      editingStep = null; editMode = null
    } catch (err) { tell('Could not save the value', err.message) }
    return
  }

  const test = e.target.closest('[data-test]')
  if (test) {
    test.disabled = true
    try { await post('/api/workflows.test', { name: test.dataset.test }) }
    catch (err) { tell('Could not start the test', err.message) }
    finally { test.disabled = false }
    return
  }

  const status = e.target.closest('[data-status]')
  if (status) {
    try { await post('/api/workflows.setStatus', { name: status.dataset.name, status: status.dataset.status }) }
    catch (err) { tell('Could not change it', err.message) }
    return
  }

  const activate = e.target.closest('[data-activate]')
  if (activate) {
    activate.disabled = true
    try { await post('/api/workflows.activate', { name: activate.dataset.activate }) }
    catch (err) { tell('Could not activate it', err.message); activate.disabled = false }
    return
  }

  const del = e.target.closest('[data-delete]')
  if (del) {
    const name = del.dataset.delete
    return ask({
      title: 'Delete ' + name + '?',
      body: 'It was recorded by hand and cannot be regenerated. Assets it produced are kept. ' +
        'To stop it running without losing it, disable it instead.',
      confirm: 'Delete it',
      danger: true,
      onConfirm: async () => {
        try {
          await post('/api/workflows.delete', { name })
          goTab('workflows')
        } catch (err) { tell('Could not delete it', err.message) }
      },
    })
  }
})

const source = new EventSource('/events')
source.onmessage = (e) => { render(JSON.parse(e.data)) }
</script>
</body>
</html>`
