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

Then load the extension: `chrome://extensions` → Developer mode → **Load unpacked** →
select `extension/`.

Register the MCP server with Claude Code (from the workspace root):

```sh
claude mcp add atelier -- node /absolute/path/to/atelier/server/dist/mcp/bin.js
```

There is nothing else to configure. The daemon starts itself on the first tool call,
the extension finds it on localhost, and the pairing is implicit because only local
processes can reach the port.

## Recording a workflow

1. Open the site, click the Atelier icon, hit **Record a workflow**, name it.
2. Do the thing once — type the prompt, click generate.
3. When the result appears, click **Capture output**, then click the image itself.
4. Hit **Stop**.

The recording is now a *draft*, not a workflow. It needs one review pass, which Claude
does: ask it to check drafts, and it reads the trace, picks the stable selectors, adds
the waits, and turns your typed prompt into a `{{prompt}}` placeholder.

**Passwords are never recorded.** A password field becomes a step that parks the job
and waits for you.

## Using it from Claude Code

```
list_workflows                → what this machine can do
run_workflow  name, inputs    → replay it, wait, return the asset
save_asset    id, path        → write the asset into the repo
list_assets                   → reuse instead of regenerate
list_drafts / get_draft / promote_draft   → the review pass
define_workflow               → hand-write or repair one
```

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
