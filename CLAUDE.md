# CLAUDE.md — Atelier

Local asset pipeline: a daemon serving MCP, and a Chrome extension that builds
and replays browser workflows to produce assets. Read `README.md` for what it
does and `docs/architecture.md` for why it is shaped this way.

## Layout

```
server/         TypeScript, Node 22+, no native deps
  src/
    daemon.ts       the long-lived process: HTTP + WebSocket + SQLite + MCP
    paths.ts        every path, in one place (ATELIER_HOME overrides)
    types.ts        the shared vocabulary; the extension mirrors these shapes
    db/             schema.sql + typed repo. All SQL lives here.
    core/runner.ts  the job state machine
    core/propose.ts a recording → a workflow. Pure, deterministic, heavily tested.
    core/inputs.ts  a workflow's signature, derived from its steps. Pure.
    core/health.ts  what each step is matching on now vs. as recorded
    core/assets.ts  content-addressed blob storage
    ws/             protocol + connection hub
    http/api.ts     the control API the MCP surface and the extension call
    http/dashboard.ts  the whole dashboard, one template literal
    mcp/tools.ts    the tool surface Claude Code sees, built per session
    mcp/session.ts  one agent session: its project binding and how it calls
    mcp/bin.ts      stdio entry — a process per session
    mcp/http.ts     Streamable HTTP entry — a session per Mcp-Session-Id
    mcp/client.ts   reaching the daemon from a spawned process (and starting it)
    mcp/direct.ts   reaching the daemon from inside the daemon
extension/      Chrome MV3, plain JS, no build step
  src/background.js        service worker: one WebSocket, dispatches steps to tabs
  src/content/replay.js    the step executor — used by replay AND by recording
  src/content/recorder.js  the in-page control panel: pick, name, act, add
  src/panel/               the popup behind the toolbar icon
```

## Working here

- **`npm run build`** compiles the server. The extension needs no build — reload
  it in `chrome://extensions` after editing.
- **`npm run build` is the only thing that typechecks.** `npm test` runs the
  suite under `--experimental-strip-types`, which strips types without checking
  them — a green suite says nothing about `tsc`. Run the build before declaring
  a change done; `exactOptionalPropertyTypes` in particular catches things the
  tests cannot.
- **`npm test`** runs `check:generic` and then the tests with
  `node --experimental-strip-types` against `src/`, so **no TypeScript parameter
  properties, enums, or namespaces** — strip-only mode rejects them. Write
  `constructor(deps: X) { this.deps = deps }`.
- **`server/test/browser.test.ts` drives the content scripts in real Chrome**
  via puppeteer-core, with a stub `chrome.runtime` that holds the recording.
  `dashboard.test.ts` drives the dashboard against a real daemon. Both skip
  themselves when no Chrome is installed. The control panel and the replay
  engine are not testable any other way, and both of the worst bugs in this
  project's history lived in them.
- Source uses `.ts` import specifiers; `rewriteRelativeImportExtensions` emits `.js`.
- `ATELIER_HOME` and `ATELIER_PORT` isolate a test instance. Use them rather than
  touching `~/.atelier`.

## Rules that are not style preferences

**The wire protocol is duplicated.** `server/src/ws/protocol.ts` and
`extension/src/protocol.js` describe the same messages. Change both, or the
daemon log fills with silently ignored frames.

**Nothing is inferred from a recording.** The person building a workflow states
what each step acts on, what it does, and who supplies its value. The old
recorder watched them work and guessed all three from a trace, which cannot
contain intent — it got the common case exactly backwards often enough that
every recording had to be corrected afterwards. Do not add a heuristic back. If
something is not known, ask for it at the moment the answer is obvious, which is
while the person is looking at the thing.

**Recording and replaying are the same code.** `content/replay.js` performs a
step whether it is being recorded or replayed, and the panel calls it for every
Add step. That is what makes a step that cannot be performed get refused while
somebody is still looking at the page. Never grow a second executor for
recording; there would be nothing to keep the two in agreement.

**What a step *does* is never editable. Where it looks, what it types, and
whether it is there at all are — but only on the dashboard.**

The two halves are not the same rule and the distinction is the point. During a
recording each step is performed against the page the previous one left behind,
so a list you can edit in the middle stops describing anything that was actually
done: the panel therefore offers no per-step delete and no way back to the
action, and Start over is the only way back. A *saved* workflow is not that. It
is an artifact being maintained, and the alternative to dropping one stray click
from it is re-recording the other nineteen — exactly the cost `repair_step`
exists to avoid. So `removeStep` is offered on the workflow's page and as
`remove_step`, and nothing anywhere re-actions a step, because a step nobody
performed is a step nobody checked.

Removal takes three things with it, and leaving any one is a bug that surfaces
later and somewhere else: the step's health, because what it matched on says
nothing about anything now; a `waitAfter` on another step whose selectors are
exactly the removed step's, or it sits out its whole timeout waiting for
something nobody will take; and the workflow's signature, which is derived from
the steps, so a removed dynamic step stops the agent being asked for a value
nothing types.

**A workflow settles between steps, and a second is the floor.** Different from
waiting for an element, which replay already does by retrying a selector until
the step's timeout — anything that can be waited *for* is handled. This is for
what cannot be: a framework re-rendering, a handler on the next tick, an
animation finishing so a click lands where it looks like it will. None of those
announce themselves, so the only honest answer is a pause. `stepDelay()` clamps
in one place so every road in — the dashboard, `set_step_delay`, a hand-written
workflow, a row written before the column existed — arrives at the same answer,
and the runner takes it *between* steps only, never before the first or after
the last.

**Waiting is a poll, and adding an observer would be a regression.** Replay
retries the selector list until the step's timeout. A MutationObserver has to be
registered and torn down on every path including the failing ones, and answers a
question nobody asked: a step whose element is not there yet and one whose
element is about to appear are the same situation. The only knob is patience,
set per step in `propose.ts`.

**Every workflow needs a non-empty `origins`.** The API rejects a save without
one. This is the guardrail that stops a mis-edited workflow acting on whatever
tab is focused — do not relax it for convenience.

**Never record a secret.** A password or OTP field offers exactly one action —
the one that parks the job — and `actionsFor()` short-circuits to it rather than
filtering. That is deliberate: "capture its text" and "capture its placeholder"
both applied on the way through, and either would have written the secret into
an asset. If you add an input type, decide explicitly which side of that line it
is on.

**A description is the only thing on a workflow that is neither recorded nor
derived, and it is never invented.** The steps, the inputs and what it produces
all say what a workflow *does*, and an agent reads every one of them; none of
them says whether it is the right thing to call. So the panel asks at Save, the
workflow's page lets it be written later, and `describe_workflow` lets an agent
write down what it worked out. When there is none, `summarise()` composes a
mechanical line **at display time** and says it is standing in — a generated
sentence *stored* as the description is how a library ends up looking documented
when nothing has been documented, and nothing can then report that a workflow
has never been explained. Do not put one back in `propose.ts`.

**A static value is never shown to the agent.** It is absent from the workflow's
inputs and no tool reports it. That is the point of marking one, and it is what
makes it safe to type an API key into a settings field while recording.

**`blocked` is not a failure.** A job that hits a login wall or a captcha parks
and resumes on the same step. Do not add automatic retries around it — the only
sensible retry is a human looking at the screen.

**The action is a popup, not a side panel.** It closes the moment it loses focus,
so nothing that has to survive the person interacting with the page may live
there — that is what the in-page control panel is for. The popup's job on
Record is to start the recording and `window.close()`; the name is asked for in
the page, where the person is already looking.

**The popup shows this page's workflows and counts the rest.** It is the surface
you reach for while standing on a site. A list you scan past to find the two
entries that apply costs more than it gives, and everything else is one click
away on the dashboard.

**Never rebuild a list that has a button in it unless it would look different.**
A click is a mousedown and a mouseup on the *same* element; destroy it in
between and the browser fires `click` on the nearest common ancestor, so the
handler never runs — silently, with nothing to see. The popup re-rendered on a
poll, on every state push, and on `window.focus`, which fires the moment you
click into a popup that did not have focus, so **every** dynamically drawn
button was swapped out from under the click meant for it. Record and Retry
always worked because they are written in the HTML. `render()` compares a
signature and returns early, holds any frame that arrives while a pointer is
down, and there is no focus listener.

**Every popup action reports what happened.** Resume and Cancel had
`try { … } finally { refresh() }` and no `catch`, so a failure was silent and a
success that left the job blocked was indistinguishable from one. `act()` runs
them all and puts the outcome — the real error, or what it did — in `#said`.

**Do not add a permission without checking the browser has it.** A permission
Chrome does not recognise is not ignored quietly: it puts a warning on the
extensions page for as long as the extension is installed, and buys nothing.
`localNetworkAccess` was added on the strength of the string appearing in
Chrome's binary; it is a policy and a feature flag, not something an extension
may ask for. A test now holds the permission list to names that have been
checked.

**A name is what a thing is called, not everything inside it.** `textContent`
concatenates every descendant regardless of layout, so a list row with a title
and a description came back as one run-on string, chopped mid-word at the
length cap, and was used as the step's name *and* as a selector.
`readableName()` takes the first line of `innerText` — a block boundary is a
newline — and cuts at a word.

**The panel reads from the daemon directly, and through the worker only when it
cannot.** `panel.js` fetches `/api/overview` over HTTP itself, because routing
panel state through the worker meant a sleeping or wedged worker made the popup
claim the daemon was down — and an MV3 listener that returns `true` without
calling `sendResponse` hangs the caller forever with nothing logged anywhere.
The worker is needed to *drive* a browser (tabs, scripting, recording); it is
not needed to *describe* one.

The fallback is there because **Chrome gates the loopback address space per
document**. Every fetch the popup made for itself was refused — *"Permission was
denied for this request to access the `loopback` address space"* — while the
worker's went through untouched, so recording kept working and every button in
the popup quietly did nothing. The manifest asks for `localNetworkAccess`, which
is the proper fix; the fallback is what makes the popup work on a browser that
refuses anyway. **Only a transport failure falls back** — an error the daemon
returned is an answer, and asking again down a different road would hide it.

**Every `chrome.runtime` call from a content script goes through `send()` in
`recorder.js`.** Reloading the extension destroys the context an injected script
belongs to while the script keeps running in the page, listeners attached and
panel on screen — so every call after that throws "Extension context
invalidated", once per click, forever. `send()` checks `chrome.runtime.id`,
catches the synchronous throw, reads `lastError` so Chrome does not log an
unchecked one, and tears the panel down. A dead context is an expected state,
not an exception. The test stub therefore carries a `runtime.id`, because real
Chrome always does and the guard is meaningless without it.

**Every message the worker accepts must be answered.** `route()` is wrapped so
that a throw still replies, and an unhandled `msg.t` still replies. Returning
`true` from `onMessage` and then not responding is the single worst failure mode
in this codebase: it is silent, it is invisible in DevTools, and it presents as
a frozen button.

**A worker broadcast does not reach a content script.**
`chrome.runtime.sendMessage` from the service worker goes to extension pages
only. The panel therefore re-reads the recording with `record.state` after every
change rather than waiting to be told — which is also why the worker is the only
thing that holds it.

**A selector lands on an element; a step acts on a control, and they are often
not the same one.** Web components very commonly mirror their attributes onto
the host and keep the real control inside, so `[placeholder="…"]` matches the
wrapper — first in document order — and the textarea is a child of it. Both
sides resolve through to the control: `replay.js` before acting, `recorder.js`
before deciding what the action list may offer, so what the panel promises is
what the step does. **One control inside a wrapper is that control; more than
one is ambiguous and the step refuses**, because typing into whichever came
first is not a mistake anyone notices quickly.

**Never hand a native setter a receiver it does not belong to.** The value
setter is taken off `HTMLInputElement.prototype` because a framework's own
property descriptor sits on top of it — and calling it on anything that is not
exactly that type throws `Illegal invocation`, which is a browser internals
message shown to somebody who was typing into a box. `setValue` picks the
prototype from what the element *is*, and falls back to a plain assignment for
anything else rather than throwing.

**Everything Atelier draws lives under `#atelier-root`, and that root is in the
top layer.** A site's own sheet — `showModal()`, or the popover API — paints in
the top layer, which is above *every* z-index; 2147483647 is the largest number
CSS takes and it loses every time. Chrome's rules, measured rather than assumed:
popovers order among themselves by when each entered, and re-entering moves you
to the front; a modal dialog is painted above every popover whatever the order;
and a popover under a modal is not inert but is not hit-testable either, because
hit testing routes everything to the modal. So there are two moves and
`keepOnTop()` picks between them by looking: be a popover, and *when a modal
dialog is on top, move inside it* — a top-layer element paints its whole
subtree, so a child of the site's own dialog is above the dialog and reachable.
Do not replace this with a bigger number.

**`#atelier-root` is the viewport and the containing block for everything in
it.** Both halves matter once we may be living inside a site's dialog: a
`position: fixed` child is positioned against the nearest ancestor with a
transform or a filter, not against the viewport, so inside such a host the panel
would arrive offset by wherever that host sits. The root declares its own
transform so it is always that ancestor, and `pinOrigin()` measures where the
root landed and slides it back onto the viewport's origin. Measuring rather than
keeping a list of the properties that establish a containing block: that list
grows, and a missing entry is a bug visible only on the one site that used it.

**`#atelier-root > * { pointer-events: auto }` must stay the last rule in
`overlay.css`.** The root is window-sized and takes no clicks, so its children
take their own back — but every control starts with `all: unset`, which resets
`pointer-events` to the inherited `none`. Both selectors are one id, so they tie
and the later one wins. Declared earlier, the launcher became unclickable *and*
invisible to `elementFromPoint`, which is how the panel decides whether it has
been buried — so it concluded it was under a site overlay while sitting on top
of one.

**Two dynamic steps cannot ask for the same name, compared on what the name
becomes.** `"Same text"`, `"SAME Text"` and `"same_text"` all serialise to
`same_text`; the caller passes one value per name, so two fields sharing one
would both receive it — silently not what anybody who drew two boxes meant.
`core/inputs.ts` owns the rule (`inputKey`, `askedName`, `nameClash`) and
`extension/src/background.js` mirrors it, the way the wire protocol is mirrored.
It is checked in the composer *before the action is performed*, because
performing it would move the page on for a step that is then refused; in the
worker, because a stale panel must not slip one past it; and in
`repo.setStepValue`, which is where the dashboard and `set_step_value` both
arrive.

**Everything Atelier draws lives under `#atelier-root`, and the executor skips
it.** The control panel is in the document while a step is being performed
through `replay.js`, so a text selector looking for "Save" would find the
panel's own Save button. The skip happens *inside* `resolveOne` rather than
after it: a selector that matches our panel first and the real control second
would otherwise resolve to the panel, be rejected, and take the whole candidate
down with it.

**`[hidden] { display: none !important }` in both stylesheets is load-bearing.**
The `hidden` attribute is implemented by the UA rule `[hidden] { display: none }`,
which any author rule setting `display` outranks — `.banner { display: flex }`
kept the offline banner permanently on screen no matter what the JS set, and
cost most of a debugging session. Both surfaces toggle visibility with `hidden`,
so do not remove that rule.

**Recording state lives in `chrome.storage.session`, never in a module
variable.** MV3 terminates the service worker after ~30s without events, and
building a workflow is time spent interacting with the *page*. A module variable
is gone by the time the person presses Save, and every step goes with it,
silently. The same applies to anything else that must outlive a single burst of
activity.

**The launcher is draggable and clamped, and the clamp is the load-bearing
half.** It is `position: fixed`, so one dragged past an edge is not scrolled
back into view by anything — it is gone for the rest of the recording, and Save
with it. `clampLauncher()` runs on every move, on window resize, and when a
navigation rebuilds the panel into a window that may be a different size.
Position is inline `!important` because the stylesheet's placement is
`!important` too, and is remembered in `sessionStorage` — wrapped, since an
opaque origin throws SecurityError on every access to it.

**A stub that always succeeds cannot fail.** The popup's tests replaced `fetch`
with something that always returned data, so a popup whose every request was
being refused looked exactly like one that worked — and the bug shipped. Any
test that stubs a transport needs a sibling that stubs it *refusing*.

**No settings page.** Anything the daemon or the extension can work out — the
port, the profile, the timeouts — is worked out. A new user-facing option needs
a reason that survives "could this be inferred?".

**There are two MCP entry points and one tool surface.** `tools.ts` is built per
session by `buildServer(session)`; `bin.ts` connects it to stdio and `http.ts`
connects one to each Streamable HTTP session. Add a tool in `tools.ts` and both
get it. An `McpServer` connects to exactly one transport, which is why this is a
factory rather than a module-scope singleton.

**A session's project binding must never be process-wide again.** It used to be
a module variable in `client.ts`, correct while one MCP process was one Claude
Code session. The daemon now serves MCP over HTTP to many sessions at once, so
it lives in the object `createSession()` returns and the caller decides the
lifetime. A module variable here would mean two agents silently sharing a
project, which is the exact failure projects were introduced to prevent.

**A token belongs to one project, and that is how a session knows where it is.**
`/mcp` resolves the presented token to a project and binds the session to it
before the first tool call. There is no fallback to the daemon's active project
for an unrecognised token — an unknown credential resolving to *some* project is
how one client's work ends up in another's. The daemon's active project is for
the dashboard and the extension only.

**`/mcp.json` must never carry `access-control-allow-origin`.** Every other
response does, for the extension. On the one response that contains a token that
wildcard would let any page the human visits read the credential and drive their
browser through it. `authorization` is likewise kept out of
`access-control-allow-headers`, so no page can even preflight a token-bearing
request. Neither omission is an oversight to tidy up.

**Every daemon capability needs an MCP tool.** The API routes exist so the MCP
surface can call them, not so a human can curl them — if a capability is only
reachable over HTTP, Claude Code cannot use it consistently and will improvise.
When you add a route to `http/api.ts`, add the matching tool in `mcp/tools.ts`
in the same change. The one deliberate exception is `projects.rotateToken`: an
agent revoking its own credential mid-session would cut itself off, and the
decision is the human's.

**The core stays generic, and `npm run check:generic` enforces it.** No named
sites, no downstream paths, no one project's conventions — in code, comments,
docs or MCP tool descriptions. This is not tidiness. `run_workflow`'s input
description once instructed every session to prepend a style guide from a path
that existed in a single downstream project, so every other user of Atelier was
pointed at a file that was not there. The logic was generic; the words around it
had drifted, which is how this always happens. Describe the class of thing, not
the product.

**A recording becomes a workflow in `core/propose.ts`, not in a conversation.**
What it decides is small now — rank the selectors, put the confirmed name on
top, derive the inputs, write the notes, set the timeouts, prepend the starting
page — but it is fixed, so it belongs in code where it is deterministic and
tested. Never move a proposal decision back into a prompt.

**A proposal is saved `status: 'draft'` and only a human activates it.** Nothing
else in the system sets a workflow to `active`. A recording that could run the
moment it stopped is a recording nobody checked.

**Replay reports which selector candidate resolved, and it must keep doing so.**
The fallback list is what makes a workflow survive a redeploy and also what
hides one. That one field on `step.ok` is the entire early-warning system; a
refactor that drops it removes the only signal that a workflow is dying.

**Never build a selector from an element's current value.** It changes between
runs, so the selector is wrong by construction — and on a password field it
writes the secret into the workflow. See `docs/security.md`.

**A dashboard control that writes must redraw, not wait for the stream.** The
write pushes a state frame, and that frame arrives *during* the `await` — so the
page re-renders while the editor is still open, and then nothing renders again
to close it. The editor sat there looking unsaved over a value that had been
saved. Both `setStepValue` and `setDescription` call `renderWorkflowPage()`
after clearing their flag, and a test asserting only the database would not have
caught it.

**A confirm raised from inside a modal `<dialog>` must itself be a `<dialog>`.**
`showModal()` puts the asset viewer in the top layer and makes everything else
inert. The dashboard's own confirm, drawn as a positioned div, rendered
perfectly on top of it and swallowed every click aimed at it — only the top
layer is above the top layer.

**Neither surface uses `window.prompt`, `confirm` or `alert`.** They are modal
to the whole tab, cannot be styled, block the event loop the live stream runs
on, and read as though the *site* is asking at the exact moment the question is
about Atelier. Both the panel and the dashboard have their own, and a test
greps for the banned ones.

**An asset is whatever a workflow captured, and that was never only pictures.**
`kindOf()` decides from the mime, which has always travelled with the asset, and
the grid and the viewer both branch on it: an image, a video that plays, audio
with a transport, a PDF in a frame, text fetched and set as text. Everything
else gets its symbol and its type rather than a blank square, because a grid of
identical blank squares is the same as no grid.

**The asset viewer's stage says which asset it is showing.** `dataset.showing`
is what decides whether to rebuild, rather than a variable kept alongside —
those drift from the close handler that resets them, and did: the stage came up
empty for everything opened after the first. Closing pauses whatever was
playing and changes nothing else, because the close event is dispatched as a
task and emptying the stage there races with the next open.

**`http/dashboard.ts` is one big template literal, so no backticks inside it.**
A backtick in a comment closes the string and the build reports a syntax error
somewhere further down, which is a confusing place to start looking. Quote
identifiers with plain words.

**The dashboard is dark by default, light by a switch in the header, remembered
in localStorage.** Same for the drawer. Both attributes are set by a script in
`<head>` so a remembered choice does not flash the wrong state on every load.
Anything drawn *on* a KPI tile uses `--on-tile-soft` / `--on-tile-cta` rather
than a hardcoded black or white tint — those assumed a light tile and either
vanished or glared once the tile was dark.

**The sidebar holds the sections of one project and nothing else.** The project
switcher, the Projects link and the theme switch are in the header, because they
are the frame everything below is read inside rather than places inside it. The
sidebar's status block was removed: every part of it was invariant,
uninteresting, or already said louder as an attention card.

## Testing browser behaviour

The control panel, the popup and the dashboard all have coverage in real Chrome
now — `browser.test.ts` and `dashboard.test.ts`. That coverage is what makes a
change to `recorder.js` or `replay.js` safe to make, so add to it rather than
declaring a behaviour untestable. If you do change one of those files in a way
the suite does not reach, say so explicitly rather than implying it did.

A dashboard page holds an SSE connection for as long as it is open, and six of
them is Chrome's per-origin cap on HTTP/1.1. `dashboard.test.ts` therefore
tracks every page it opens and closes them in `after()` — without that, one
genuine failure presents as six, with the five downstream ones pointing nowhere
useful.
