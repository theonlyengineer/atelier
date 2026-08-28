# Architecture

## Why a daemon

Claude Code spawns one MCP process per session. If that process owned the WebSocket the
extension connects to, then two Claude Code sessions would bind the same port, one would
lose, and the extension would flap between them. So the MCP process holds no state: it
finds the daemon on localhost, starts it if it is not up, and forwards.

The daemon is the only thing that touches SQLite, the only thing the extension talks to,
and the only thing that outlives a session.

## Storage

- `~/.atelier/atelier.db` — workflows, jobs, job events, asset metadata, drafts
- `~/.atelier/assets/<ab>/<sha256>` — blobs, content-addressed

Content addressing means the same image generated twice costs one file while staying two
asset rows — because "what prompt produced this" has two different answers and both are
worth keeping.

`job_event` is append-only. It is how a cold session reconstructs what a job actually
did, which matters because a job can sit parked for hours.

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

Sending one step and awaiting an ack is slower than shipping the whole list. It is what
makes a job resumable from the exact step that failed, which is the entire point of the
human-in-the-loop design.

`blocked` is not an error state. It is the normal outcome of a login wall, a captcha, or
a closed browser, and it is the only thing that raises a notification.

## Selectors

The recorder captures **every** way it can name an element, scored:

| Strategy | Score | Why |
|---|---|---|
| `testid` | 98 | put there to be selected; survives everything |
| `id` | 92 | stable unless generated |
| `aria` | 88 | semantic; survives restyling |
| `role` | 84 | role + accessible name |
| `name` | 80 | form fields |
| `placeholder` | 76 | stable-ish, user-visible |
| `text` | 60 | breaks on copy edits and i18n |
| `css` | 40 | structural path; breaks on markup changes |
| `xpath` | 30 | last resort |

Generated-looking ids and classes (`css-1x2y3z`, anything with a long hex run) are
skipped, because a workflow that looks robust and is not is worse than one that
obviously needs a fallback.

Replay tries candidates highest-score-first until one resolves to a *visible* element.
Keeping the alternatives is what lets a workflow survive a redeploy of the site.

## The review pass

A recording is a `draft`, not a workflow. The gap between them is judgement:

- which selector to prefer, and which to keep as fallbacks
- where the page needs a wait — especially after the action that triggers generation
- which recorded text is a parameter (`{{prompt}}`) rather than a constant
- which clicks were incidental and should be dropped

Claude Code does this through `get_draft` / `promote_draft` rather than the server doing
it with its own API key. That keeps the credential count at zero and puts a human-visible
diff between "I clicked some things" and "this is a thing that runs".

## Extension lifetime

MV3 terminates service workers aggressively. Rather than fight it, the WebSocket is
treated as disposable: an alarm wakes the worker, it reconnects, and the daemon re-sends
the current step for any running job. Nothing is kept in memory that a reconnect cannot
rebuild.
