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
    core/assets.ts  content-addressed blob storage
    ws/             protocol + connection hub
    http/api.ts     the control API the MCP process calls
    mcp/bin.ts      the tool surface Claude Code sees
extension/      Chrome MV3, plain JS, no build step
  src/background.js     service worker: one WebSocket, dispatches steps to tabs
  src/content/replay.js recorder-independent step executor
  src/content/recorder.js  captures actions with many selector candidates
  src/panel/            the side panel
```

## Working here

- **`npm run build`** compiles the server. The extension needs no build — reload it in
  `chrome://extensions` after editing.
- **`npm test`** runs the unit tests with `node --experimental-strip-types` against
  `src/`, so **no TypeScript parameter properties, enums, or namespaces** — strip-only
  mode rejects them. Write `constructor(deps: X) { this.deps = deps }`.
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

**The panel reads from the daemon, not from the service worker.** `panel.js` fetches
`/api/overview` over HTTP directly. Routing panel state through the worker meant a
sleeping or wedged worker made the panel claim the daemon was down — and an MV3 listener
that returns `true` without calling `sendResponse` hangs the caller forever with nothing
logged anywhere. The worker is needed to *drive* a browser (tabs, scripting, recording);
it is not needed to *describe* one. Keep that split.

**Every message the worker accepts must be answered.** `route()` is wrapped so that a
throw still replies, and an unhandled `msg.t` still replies. Returning `true` from
`onMessage` and then not responding is the single worst failure mode in this codebase:
it is silent, it is invisible in DevTools, and it presents as a frozen button.

**`[hidden] { display: none !important }` in both stylesheets is load-bearing.** The
`hidden` attribute is implemented by the UA rule `[hidden] { display: none }`, which any
author rule setting `display` outranks — `.banner { display: flex }` kept the offline
banner permanently on screen no matter what the JS set, and cost most of a debugging
session. Both surfaces toggle visibility with `hidden`, so do not remove that rule.

**No settings page.** Anything the daemon or the extension can work out — the port, the
profile, the timeouts — is worked out. A new user-facing option needs a reason that
survives "could this be inferred?".

## Testing browser behaviour

There is no automated coverage for the extension yet; it is verified by hand in Chrome.
When changing `replay.js` or `recorder.js`, say so explicitly rather than implying the
suite covered it.
