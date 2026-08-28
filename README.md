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

**`http://127.0.0.1:7717`** — the dashboard. Whether the daemon is up, which browsers
are connected, what is running, what is stuck, the workflows it knows, thumbnails of
recent assets, and the tail of the log. It updates live; there is nothing to refresh.

The dashboard and the extension side panel are deliberately different things. The
**side panel** is the action surface: the one or two things that need you, in the
browser where you would act on them. The **dashboard** is the observation surface:
everything, with detail, for when something is wrong and you want to look at it.

If the page will not load at all, the daemon is not running — `npm start`, or check
`~/.atelier/atelierd.log`.

## Recording a workflow

1. Open the site, click the Atelier icon, hit **Record a workflow**, name it.
2. Do the thing once — type the prompt, click generate.
3. When the result appears, click **Capture output**, then click the image itself.
4. Hit **Stop** — in the page bar or the side panel. **That is what saves it.**

There is no separate save button. Stop writes the recording to the daemon and the
panel confirms with the action count.

The recording is now a *draft*, not a workflow. It needs one review pass, which Claude
does: ask it to check drafts, and it reads the trace, picks the stable selectors, adds
the waits, and turns your typed prompt into a `{{prompt}}` placeholder.

**Passwords are never recorded.** A password field becomes a step that parks the job
and waits for you.

## Using it from Claude Code

```
atelier_status                → is the daemon up, is a browser attached
list_workflows                → what this machine can do
run_workflow  name, inputs    → replay it, wait, return the asset
list_jobs / job_status        → what ran, what is parked
resume_job / cancel_job       → after the human clears an obstacle
save_asset    id, path        → write the asset into the repo
list_assets                   → reuse instead of regenerate
list_drafts / get_draft / promote_draft / delete_draft   → the review pass
define_workflow / delete_workflow                        → hand-write or remove one
```

Check `atelier_status` before `run_workflow`: a workflow with no browser attached parks
and waits for a human, which is slower than saying so up front.

For images on theonlyengineer.com, the prompt is the style guide from
`gtm/wiki/image-style-guide.md` plus a one-line subject. Claude composes it; the
workflow just types whatever it is given.

## When something goes wrong

A job that hits a login wall, a captcha, a changed page, or a closed browser does not
fail — it **parks**. You get one notification, the side panel shows what it needs, and
**Resume** retries the exact step it stopped on. Claude is told to wait rather than
retry.

That is the whole error model. There is no retry configuration, because the only
sensible retry is a human looking at the screen.

## What is deliberately absent

- **No settings page.** Ports are probed, profiles are detected, timeouts come from the
  review pass. Nothing that can be worked out is asked.
- **No cloud.** The daemon binds `127.0.0.1`. Assets never leave the machine unless you
  copy them into a repo.
- **No unscoped automation.** Every workflow carries an origin allowlist and replay
  refuses to act outside it.

See `docs/architecture.md` for how it fits together, and `docs/security.md` for what
this can and cannot do.
