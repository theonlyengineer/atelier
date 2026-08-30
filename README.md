# Atelier

A local asset pipeline. Claude Code asks for an image; a workflow you recorded once
in your browser produces it; the file lands in your repo.

Three pieces:

```
Claude Code ──stdio──► atelier-mcp ──HTTP──► atelierd ──WebSocket──► Chrome extension
                       (per session)         (one, local)            (records + replays)
```

`atelier-mcp` is a thin client. **`atelierd` owns everything** — the database, the
assets, the browser connection. That split exists because Claude Code spawns one MCP
process per session, and a session-owned WebSocket port would mean two sessions
fighting over the extension.

## Install

```sh
npm install
npm run build
```

### Load the extension

1. Open **`chrome://extensions`**
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the **`extension/`** folder in this repo
4. Pin Atelier to the toolbar, and click it to open the side panel

The extension finds the daemon on localhost by itself. There is nothing to paste and
no settings page.

It asks for **no site access at install time.** Permission is requested for one origin
at a time, at the moment you start recording on it — so the guarantee that Atelier can
only touch the sites you recorded on is enforced by the browser, not just promised
here.

### Start the daemon

It starts itself the first time Claude Code calls a tool, so usually you do nothing.
To run it by hand — to look at the dashboard before wiring anything up:

```sh
npm start
```

### Register with Claude Code

From the workspace root:

```sh
claude mcp add atelier -- node /absolute/path/to/atelier/server/dist/mcp/bin.js
```

There is nothing else to configure. The pairing is implicit because only local
processes can reach the port.

## Where to look

**`http://127.0.0.1:7717`** — the dashboard. It updates live; there is nothing to
refresh.

**Overview** opens with a little of everything — health, run success and assets as three
figures, runs over the last fortnight, outcomes, and the top of each list — so the first
screen answers the question rather than asking which section you wanted. Then
**Workflows**, **Runs**, **Assets** and **Log** for the detail.

Two things are never behind a section: **a parked job and a detached browser.** Those are
the states where Atelier is stuck waiting on a person, and a status page that makes you go
looking for them is worse than one long scroll. Counts sit on the nav so nothing has to be
opened to be noticed, and the section lives in the URL so a reload — or a link — puts you
back where you were.

**Assets are clickable.** Full size, the prompt that made it, and a **description** you can
write: what the asset actually *shows*, as opposed to what was asked for. That field is the
one anything choosing between assets later has to go on — including an agent, which reads
`list_assets` rather than the pixels — so `describe_asset` writes it and `list_assets`
returns it.

The dashboard and the extension side panel are deliberately different things. The
**side panel** is the action surface: the one or two things that need you, in the
browser where you would act on them. The **dashboard** is the observation surface:
everything, with detail, for when something is wrong and you want to look at it.

If the page will not load at all, the daemon is not running — `npm start`, or check
`~/.atelier/atelierd.log`.

## Recording a workflow

1. Open the site, click the Atelier icon, hit **Record a workflow**, name it.
2. Do the task once. Every click and every field is captured, and the side panel lists
   them as they happen — so you can see it heard the right thing rather than trusting a
   counter.
3. Point at the result with **Capture result**. **It does not have to exist yet.**
   Click where it will appear and Atelier watches that region until something turns up.
4. **Save recording.**

**Why step 3 is the important one.** At the moment you click Generate, the thing you are
waiting for does not exist, so there is nothing to click. A recorder that captures by
clicking a finished result can therefore never record the wait that produced it — which
is most of what makes a workflow work. Pointing at the empty region instead is what
closes that gap.

Use **Wait for…** for anything else the page has to do before the next step — a spinner
appearing, a dialog closing. Hold Alt while pointing to wait for something to *go* rather
than arrive.

**Saving writes the workflow.** Atelier orders the selectors, inserts the waits, turns
your longest typed value into a `{{placeholder}}` and works out what the workflow
produces. The side panel shows you the result, step by step, and nothing runs until you
press **Activate**. No other application is involved.

**Passwords are never recorded** — not the value, and not as part of a selector. A
password field becomes a step that parks the job and hands you the keyboard.

## When a workflow starts to rot

Replay tries every selector it recorded, best first, and uses whichever resolves. That
is what carries a workflow through a redeploy — and it is also what hides one, because a
step quietly matching on its position in the page looks exactly like a step matching on
a stable test id, right up until the layout moves too.

So replay reports which candidate won, and Atelier compares it to the one the step was
recorded against. `workflow_health` and the side panel say what is decaying and how
badly, before it breaks. When something has moved, **Re-record** that one step from the
panel — the other nineteen were fine.

## Using it from Claude Code

```
atelier_status                → is the daemon up, is a browser attached, is anything rotting
list_workflows                → what this machine can do
get_workflow  name            → every step, with ids and health
run_workflow  name, inputs    → replay it, wait, return the asset
workflow_health [name]        → what each step is matching on now vs. as recorded
repair_step   name, stepId    → fix one step without touching the rest
list_jobs / job_status        → what ran, what is parked
resume_job / cancel_job       → after the human clears an obstacle
save_asset    id, path        → write the asset into the repo
list_assets                   → reuse instead of regenerate
list_drafts / get_draft       → the raw trace, for diagnosing a bad proposal
define_workflow / delete_workflow / promote_draft        → hand-write or replace one
```

Check `atelier_status` before `run_workflow`: a workflow with no browser attached parks
and waits for a human, which is slower than saying so up front.

A workflow types whatever string it is handed and applies no house style of its own.
Anything long-form — a prompt, a message body, a search query — is composed by the
caller and passed whole, so where that text comes from stays a property of your project
rather than of Atelier.

**Nothing in the core names a site.** `npm run check:generic` fails the build if it
does. A general tool that knows about one particular service is a tool that only really
works for whoever wrote it, and the drift is invisible — the logic stays correct while
the words around it rot.

## When something goes wrong

A job that hits a login wall, a captcha, a changed page, or a closed browser does not
fail — it **parks**. You get one notification, the side panel shows what it needs, and
**Resume** retries the exact step it stopped on. Claude is told to wait rather than
retry.

That is the whole error model. There is no retry configuration, because the only
sensible retry is a human looking at the screen.

## What is deliberately absent

- **No settings page.** Ports are probed, profiles are detected, timeouts and selector
  ordering are worked out when a recording is saved. Nothing that can be derived is
  asked.
- **No review queue.** A recording becomes a workflow the moment it is saved. You
  confirm it; you are never asked to go and prompt something else to finish it.
- **No cloud.** The daemon binds `127.0.0.1`. Assets never leave the machine unless you
  copy them into a repo.
- **No unscoped automation.** Every workflow carries an origin allowlist and replay
  refuses to act outside it.

See `docs/architecture.md` for how it fits together, and `docs/security.md` for what
this can and cannot do.
