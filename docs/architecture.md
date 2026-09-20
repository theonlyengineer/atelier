# Architecture

## Why a daemon

The daemon is the only thing that touches SQLite, the only thing the extension
talks to, and the only thing that outlives a session. It serves the MCP surface
itself, over Streamable HTTP, so an agent needs a URL and a token rather than a
checkout and a build.

There is also a spawned stdio entry point, kept because it needs nothing running
first. That process holds no state: it finds the daemon on localhost, starts it
if it is not up, and forwards. If it owned the WebSocket the extension connects
to, two Claude Code sessions would bind the same port, one would lose, and the
extension would flap between them.

## The token is the wiring

A token belongs to exactly one project, and is issued when the project is
created. Presenting it on `/mcp` is both how a request gets in and how the
session knows where it is working — the binding is set before the agent's first
tool call, from the credential it already sent.

That replaced one token for the whole daemon, which got an agent through the
door and then left it to ask which project it was in. A question with a wrong
answer nobody notices quickly is worse than no question, and the answer was
sitting in the request the whole time.

An unrecognised token resolves to nothing and the request is refused. There is
deliberately no fallback to whichever project the dashboard is showing.

## Storage

- `~/.atelier/atelier.db` — projects and their tokens, workflows, jobs, job
  events, asset metadata, recordings. Chmod 0600 at open: it holds credentials.
- `~/.atelier/assets/<ab>/<sha256>` — blobs, content-addressed

Content addressing means the same image generated twice costs one file while
staying two asset rows — because "what prompt produced this" has two different
answers and both are worth keeping.

`job_event` is append-only. It is how a cold session reconstructs what a job
actually did, which matters because a job can sit parked for hours.

## The job state machine

One step is in flight at a time, per job:

```
queued ──► running ──► done
             │  ▲
             ▼  │ resume (retries the same step)
          blocked
             │
             ▼ (unrecoverable)
          failed
```

Sending one step and awaiting an ack is slower than shipping the whole list. It
is what makes a job resumable from the exact step that failed, which is the
entire point of the human-in-the-loop design.

`blocked` is not an error state. It is the normal outcome of a login wall, a
captcha, or a closed browser, and it is the only thing that raises a
notification.

## Recording is directed, not observed

The extension does not watch a person work. They point at an element, confirm
what to call it, pick an action from the ones that element can take, and say
whether its value is theirs or the caller's. Then Atelier performs the step.

This replaced a recorder that captured clicks and keystrokes and inferred a
workflow from the trace. The inference was the problem, not the implementation:
which value varies between runs, which click was incidental, which pause was the
page and which was the person — none of it is in a trace, so all of it was
guessed. The guesses were wrong often enough that every recording had to be
corrected afterwards, which is a worse job than building it in the first place.

Two properties follow, and both are enforced rather than intended:

**The extension performs every action.** Add step runs the composed step through
`content/replay.js` — the same executor that will replay it later. A step that
cannot be performed is refused while somebody is still looking at the page.
There is no separate "recording" code path to drift from the replaying one,
because there is no separate code path.

**A recorded step cannot be removed or re-actioned.** Only its value can change.
A step list you can edit in the middle stops describing anything that was
actually performed, and that it describes exactly what was performed is the
whole value of it. Start over is the escape hatch.

## Staying on top of the page

The panel is drawn over a document Atelier knows nothing about, and the naive
answer — the largest z-index there is — stopped working the day sites started
using real modals. `showModal()` and the popover API paint in the **top layer**,
which is above every z-index; 2147483647 is the biggest number CSS takes and it
loses every time.

Chrome's rules, measured rather than assumed:

- Popovers are ordered among themselves by when each entered the top layer, and
  leaving and re-entering moves you to the front.
- A modal dialog is painted above *every* popover, whatever the order. There is
  no way to get above one from outside it.
- A popover under a modal dialog is not inert, but it is not hit-testable
  either: hit testing routes every point to the modal. Being painted under one
  and being unreachable arrive together.

So there are two moves, and which is needed is decided by looking — one hit test
at the point a person would aim at, throttled, on pointer movement. Moving the
mouse is the signal that somebody is about to reach for the panel, which makes
this self-healing before the first click rather than after it.

1. **Be a popover.** That beats every ordinary overlay and every site popover.
2. **When a modal dialog is on top, move inside it.** A top-layer element paints
   its whole subtree, so a child of the site's own dialog is above the dialog —
   and still interactive, and still able to watch clicks on the only part of the
   page that is not inert, which is the part being recorded against anyway.

The root declares its own transform, so it is always the containing block for
the panel and the launcher, and `pinOrigin()` measures where it landed and
slides it back onto the viewport's origin. Without that, living inside a host
that establishes a containing block would offset everything by wherever that
host sits.

## Selectors

The recorder captures **every** way it can name an element, scored:

| Strategy | Score | Why |
|---|---|---|
| `testid` | 98 | put there to be selected; survives everything |
| *confirmed name* | 96 | a person looked at it and said what it is |
| `id` | 92 | stable unless generated |
| `aria` | 88 | semantic; survives restyling |
| `role` | 84 | role + accessible name |
| `name` | 80 | form fields |
| `placeholder` | 76 | stable-ish, user-visible |
| `text` | 60 | breaks on copy edits and i18n |
| `css` | 40 | structural path; breaks on markup changes |
| `xpath` | 30 | last resort |

The confirmed name leads the list when it still resolves to the element it was
confirmed on, because it is the only candidate a human would recognise when the
step stops working. If the person renamed the step to something the page has
never heard of, the name stays the step's *name* and the lookup falls to the
harvested candidates — keeping a selector that does not resolve would read as
decay forever afterwards.

Generated-looking ids and classes (`css-1x2y3z`, anything with a long hex run)
are skipped, because a workflow that looks robust and is not is worse than one
that obviously needs a fallback.

Replay tries candidates highest-score-first until one resolves to a *visible*
element, skipping anything inside Atelier's own `#atelier-root` — the control
panel is in the document while a step is being recorded, and it is performed
through this same executor at that moment.

## Waiting, and why there is no observer

A page changes a variable amount of time after the previous step: a route
change, a render, a generation that takes ninety seconds. Replay handles all of
it with one mechanism — try every candidate, and if none resolves, look again a
fraction of a second later until the step's timeout runs out.

A MutationObserver was considered and rejected. It costs more, has to be
registered and torn down correctly on every path including the failing ones, and
answers a question nobody asked: a step whose element is not there yet and one
whose element is about to appear are the same situation, and waiting handles
both without knowing which it is in.

So the only knob is patience, set per step when the workflow is saved: 30
seconds for an ordinary step, three minutes for a capture, three minutes for an
explicit wait.

## One name, one value

A workflow's inputs are derived from its steps, so two dynamic steps with the
same name are one input that two fields both receive. That is silently not what
anybody who drew two boxes meant, so it is refused where the name is given.

The comparison is on what the name *becomes*: `inputKey()` in `core/inputs.ts`
lowercases and underscores, so "Same text", "SAME Text" and "same_text" are one
name. Comparing the raw strings would let all three through.

Three places check, and none of them is redundant. The composer checks *before
performing the action*, because performing it would move the page on for a step
that is then refused. The service worker checks because it owns the recording
and a stale panel must not slip one past it. `repo.setStepValue` checks because
that is where the dashboard and the `set_step_value` tool both arrive, long
after the recording is over.

## The proposal pass

`core/propose.ts` assembles a recording into a workflow. It no longer decides
anything — the person did — so what is left is: rank the selectors and put the
confirmed name at the top, derive the workflow's inputs from the steps marked
dynamic, write the notes a human reads when it breaks, set the timeouts, and
prepend the page it started on.

It is pure, deterministic and tested, for the reason it always was: these are
the same rules every time, so they should not be re-decided in a conversation.

The output is always `status: 'draft'`. A recording that could run the moment it
stopped is a recording nobody checked.

## Extension lifetime

MV3 terminates service workers aggressively. Rather than fight it, the WebSocket
is treated as disposable: an alarm wakes the worker, it reconnects, and the
daemon re-sends the current step for any running job. Nothing is kept in memory
that a reconnect cannot rebuild.

The recording itself lives in `chrome.storage.session`, never in a module
variable. A recording is by definition time spent interacting with the page, most
of it waiting; a module variable is gone by the time Save is pressed, and every
step goes with it, silently.
