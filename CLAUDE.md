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

**Recording state lives in `chrome.storage.session`, never in a module variable.** MV3
terminates the service worker after ~30s without events, and a recording session is time
spent interacting with the *page* — for image generation, mostly spent waiting for a
render. A module variable is gone by the time the user presses Stop, and every captured
action goes with it, silently. The same applies to anything else that must outlive a
single burst of activity.

**No settings page.** Anything the daemon or the extension can work out — the port, the
profile, the timeouts — is worked out. A new user-facing option needs a reason that
survives "could this be inferred?".

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
