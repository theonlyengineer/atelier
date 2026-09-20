# CLAUDE.md — Atelier

Local asset pipeline: an MCP server, a daemon, and a Chrome extension that record and
replay browser workflows to produce assets. Read `README.md` for what it does and
`docs/architecture.md` for why it is shaped this way.

## Layout

```
server/         TypeScript, Node 22+, no native deps
  src/
    daemon.ts       the long-lived process: HTTP + WebSocket + SQLite
    paths.ts        every path, in one place (ATELIER_HOME overrides)
    types.ts        the shared vocabulary; the extension mirrors these shapes
    db/             schema.sql + typed repo. All SQL lives here.
    core/runner.ts  the job state machine
    core/propose.ts a recording → a workflow. Pure, deterministic, heavily tested.
    core/health.ts  what each step is matching on now vs. as recorded
    core/assets.ts  content-addressed blob storage
    ws/             protocol + connection hub
    http/api.ts     the control API the MCP process calls
    mcp/tools.ts    the tool surface Claude Code sees, built per session
    mcp/session.ts  one agent session: its project binding and how it calls
    mcp/bin.ts      stdio entry — a process per session
    mcp/http.ts     Streamable HTTP entry — a session per Mcp-Session-Id
    mcp/client.ts   reaching the daemon from a spawned process (and starting it)
    mcp/direct.ts   reaching the daemon from inside the daemon
    core/token.ts   the shared secret the .mcp.json carries
extension/      Chrome MV3, plain JS, no build step
  src/background.js     service worker: one WebSocket, dispatches steps to tabs
  src/content/replay.js recorder-independent step executor
  src/content/recorder.js  captures actions with many selector candidates
  src/panel/            the popup behind the toolbar icon
```

## Working here

- **`npm run build`** compiles the server. The extension needs no build — reload it in
  `chrome://extensions` after editing.
- **`npm run build` is the only thing that typechecks.** `npm test` runs the suite
  under `--experimental-strip-types`, which strips types without checking them —
  a green suite says nothing about `tsc`. Run the build before declaring a change
  done; `exactOptionalPropertyTypes` in particular catches things the tests cannot.
- **`npm test`** runs `check:generic` and then the tests with
  `node --experimental-strip-types` against `src/`, so **no TypeScript parameter
  properties, enums, or namespaces** — strip-only mode rejects them. Write
  `constructor(deps: X) { this.deps = deps }`.
- **`server/test/browser.test.ts` drives the content scripts in real Chrome** via
  puppeteer-core, with a stub `chrome.runtime`. It skips itself when no Chrome is
  installed. The recorder and the replay engine are not testable any other way, and both
  of the worst bugs in this project's history lived in them.
- Source uses `.ts` import specifiers; `rewriteRelativeImportExtensions` emits `.js`.
- `ATELIER_HOME` and `ATELIER_PORT` isolate a test instance. Use them rather than
  touching `~/.atelier`.

## Rules that are not style preferences

**The wire protocol is duplicated.** `server/src/ws/protocol.ts` and
`extension/src/protocol.js` describe the same messages. Change both, or the daemon log
fills with silently ignored frames.

**Every workflow needs a non-empty `origins`.** The API rejects a save without one. This
is the guardrail that stops a mis-edited workflow acting on whatever tab is focused —
do not relax it for convenience.

**Never record a secret.** `recorder.js` drops the value of password and OTP fields and
marks the step `manual`. If you add a new input type, decide explicitly which side of
that line it is on.

**`blocked` is not a failure.** A job that hits a login wall or a captcha parks and
resumes on the same step. Do not add automatic retries around it — the only sensible
retry is a human looking at the screen.

**The action is a popup, not a side panel.** It closes the moment it loses focus, so
nothing that has to survive the person interacting with the page may live there — that
is what the in-page bar is for. `body` carries an explicit width because Chrome sizes a
popup to its content and gives it none.

**The panel reads from the daemon, not from the service worker.** `panel.js` fetches
`/api/overview` over HTTP directly. Routing panel state through the worker meant a
sleeping or wedged worker made the panel claim the daemon was down — and an MV3 listener
that returns `true` without calling `sendResponse` hangs the caller forever with nothing
logged anywhere. The worker is needed to *drive* a browser (tabs, scripting, recording);
it is not needed to *describe* one. Keep that split.

**Every `chrome.runtime` call from a content script goes through `send()` in
`recorder.js`.** Reloading the extension destroys the context an injected script belongs
to while the script keeps running in the page, listeners attached and bar on screen — so
every call after that throws "Extension context invalidated", once per click, forever.
`send()` checks `chrome.runtime.id`, catches the synchronous throw, reads `lastError` so
Chrome does not log an unchecked one, and tears the bar down. A dead context is an
expected state, not an exception. The test stub therefore carries a `runtime.id`, because
real Chrome always does and the guard is meaningless without it.

**Every message the worker accepts must be answered.** `route()` is wrapped so that a
throw still replies, and an unhandled `msg.t` still replies. Returning `true` from
`onMessage` and then not responding is the single worst failure mode in this codebase:
it is silent, it is invisible in DevTools, and it presents as a frozen button.

**`[hidden] { display: none !important }` in both stylesheets is load-bearing.** The
`hidden` attribute is implemented by the UA rule `[hidden] { display: none }`, which any
author rule setting `display` outranks — `.banner { display: flex }` kept the offline
banner permanently on screen no matter what the JS set, and cost most of a debugging
session. Both surfaces toggle visibility with `hidden`, so do not remove that rule.

**Recording state lives in `chrome.storage.session`, never in a module variable.** MV3
terminates the service worker after ~30s without events, and a recording session is time
spent interacting with the *page* — for image generation, mostly spent waiting for a
render. A module variable is gone by the time the user presses Stop, and every captured
action goes with it, silently. The same applies to anything else that must outlive a
single burst of activity.

**No settings page.** Anything the daemon or the extension can work out — the port, the
profile, the timeouts — is worked out. A new user-facing option needs a reason that
survives "could this be inferred?".

**There are two entry points and one tool surface.** `tools.ts` is built per
session by `buildServer(session)`; `bin.ts` connects it to stdio and `http.ts`
connects one to each Streamable HTTP session. Add a tool in `tools.ts` and both
get it. An `McpServer` connects to exactly one transport, which is why this is a
factory rather than a module-scope singleton.

**A session's project binding must never be process-wide again.** It used to be a
module variable in `client.ts`, correct while one MCP process was one Claude Code
session. The daemon now serves MCP over HTTP to many sessions at once, so it
lives in the object `createSession()` returns and the caller decides the
lifetime. A module variable here would mean two agents silently sharing a
project, which is the exact failure projects were introduced to prevent.

**The token is the boundary for `/mcp`, and the publish binding is the boundary
for everything else.** Inside a container every request arrives from a bridge
gateway, so the loopback check stands down when `ATELIER_BIND` is not loopback —
see `paths.ts`. What keeps the daemon private there is that compose publishes to
the host's loopback.

**`/mcp.json` must never carry `access-control-allow-origin`.** Every other
response does, for the extension. On the one response that contains the token
that wildcard would let any page the human visits read the credential and drive
their browser through it. `authorization` is likewise kept out of
`access-control-allow-headers`, so no page can even preflight a token-bearing
request. Neither omission is an oversight to tidy up.

**Every daemon capability needs an MCP tool.** The API routes exist so the MCP process
can call them, not so a human can curl them — if a capability is only reachable over HTTP,
Claude Code cannot use it consistently and will improvise. When you add a route to
`http/api.ts`, add the matching tool in `mcp/bin.ts` in the same change.

## Testing browser behaviour

There is no automated coverage for the extension yet; it is verified by hand in Chrome.
When changing `replay.js` or `recorder.js`, say so explicitly rather than implying the
suite covered it.

**The core stays generic, and `npm run check:generic` enforces it.** No named sites, no
downstream paths, no one project's conventions — in code, comments, docs or MCP tool
descriptions. This is not tidiness. `run_workflow`'s input description once instructed
every session to prepend a style guide from a path that existed in a single downstream
project, so every other user of Atelier was pointed at a file that was not there. The
logic was generic; the words around it had drifted, which is how this always happens.
Describe the class of thing, not the product.

**A recording becomes a workflow in `core/propose.ts`, not in a conversation.** The
rules — order the selectors, keep every candidate, collapse repeated typing, parameterise
the longest value, insert the wait before a capture and the wait after its trigger — are
fixed, so they belong in code where they are deterministic and tested. Never move a
proposal decision back into a prompt.

**The bar is draggable and clamped, and the clamp is the load-bearing half.** It is
`position: fixed`, so a bar dragged past an edge is not scrolled back into view by
anything — it is gone for the rest of the recording, and so is Save. `clampBar()` runs on
every move, on window resize, and when a navigation rebuilds the bar into a window that may
be a different size. Position is inline `!important` because the stylesheet's centring is
`!important` too, and is remembered in `sessionStorage` — wrapped, since an opaque origin
throws SecurityError on every access to it.

**Enter is only a step where it does something.** In a textarea or a contenteditable it
inserts a newline, which the typed value already carries — recording a `key` step there was
wrong on its own, and it also landed *between* two bursts of typing, which is what stopped
them merging. A multi-line value therefore arrived as three steps however well the merge
worked. In a single-line input Enter submits, and that is the step that makes the workflow
go, so it is still recorded.

**Typing into the field you are already typing into is not another step.**
`addAction` merges a `type` into the immediately preceding one when it is a `type` on the
same field — the same rule `propose.ts` applies, moved to where the recording is stored so
every screen before the proposal shows steps rather than keystroke bursts. Two things it
must keep doing: only against the *immediately* preceding action, because type-here,
click-there, type-here-again is three things in the order replay follows; and only between
two `type`s, because clicking a field to focus it and then typing into it are both on the
same element and are two steps.

**The recording is reviewed in the page, not in the popup.** `Save recording` opens
`#atelier-review` — every step with the value it will type — and nothing is written until
that is confirmed. The popup shows the same list, but it is the second place to look, not
the first: a person who just recorded something is looking at the page. Both surfaces read
the worker's session storage, and the review re-reads after every change rather than
patching its own DOM, so it cannot drift from what will be saved.

**Typing something in a recording means it is a value the caller supplies.** Every typed
field becomes an input; `role: 'fixed'` — a tick in the popup — is the only exception, and
means "keep the recorded text". There is no heuristic here any more and adding one back
would be a mistake: the previous rule made the *longest* typed value the parameter, which
inverted the common case exactly, freezing the short thing that varies and demanding the
long constant that does not. Getting the default right removed the need to guess.

**The dashboard is dark by default, light by a switch in the sidebar, remembered in
localStorage.** The attribute is set by a script in `<head>` so a remembered choice does
not flash the wrong theme on every load. Anything drawn *on* a KPI tile uses
`--on-tile-soft` / `--on-tile-cta` rather than a hardcoded black or white tint — those
assumed a light tile and either vanished or glared once the tile was dark.

**A proposal is saved `status: 'draft'` and only a human activates it.** Nothing else in
the system sets a workflow to `active`. A recording that could run the moment it stopped
is a recording nobody checked.

**Replay reports which selector candidate resolved, and it must keep doing so.** The
fallback list is what makes a workflow survive a redeploy and also what hides one. That
one field on `step.ok` is the entire early-warning system; a refactor that drops it
removes the only signal that a workflow is dying.

**Never build a selector from an element's current value.** It changes between runs, so
the selector is wrong by construction — and on a password field it writes the secret into
the workflow. See `docs/security.md`.

**`http/dashboard.ts` is one big template literal, so no backticks inside it.** A backtick
in a comment closes the string and the build reports a syntax error somewhere further
down, which is a confusing place to start looking. Quote identifiers with plain words.
