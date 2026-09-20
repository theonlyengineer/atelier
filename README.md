# Atelier

A local asset pipeline. Claude Code asks for an image; a workflow you built once
in your browser produces it; the file lands in your repo.

Three pieces:

```
Claude Code ──HTTP──► atelierd ──WebSocket──► Chrome extension
              (token)  (one, local)           (builds + replays workflows)
```

`atelierd` **owns everything** — the database, the assets, the browser
connection. The agent reaches it over HTTP with a token that belongs to one
project, which is the whole of the wiring: an agent presenting it is working in
that project and never has to be told where it is.

## Getting started

Three steps, and there is nothing to configure between them.

**1. Start the daemon.**

```sh
docker compose up -d
```

No `.env`, no environment variables, nothing to generate. State lives on a named
volume, so workflows, assets and tokens survive a rebuild.

*(If you would rather run it on the host: `npm install && npm run build && npm
start`. Same daemon, same everything.)*

**2. Load the extension.**

1. Open **`chrome://extensions`**
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the **`extension/`** folder in this repo
4. Pin Atelier to the toolbar

The extension finds the daemon on localhost by itself. There is nothing to paste
and no settings page.

It asks for **local network access**, which recent Chrome requires before
anything may reach `127.0.0.1` — without it the popup can see nothing and its
buttons do nothing. If you are on a Chrome old enough not to know that
permission it is ignored with a warning, and everything still works.

It asks for **no site access at install time.** Permission is requested for one
origin at a time, at the moment you start recording on it — so the guarantee
that Atelier can only touch the sites you recorded on is enforced by the
browser, not just promised here.

**3. Connect your agent.**

Open **`http://127.0.0.1:7717`**, go to **Connect**, and download the
`.mcp.json`. Drop it beside a repository. Claude Code has the tools.

```json
{
  "mcpServers": {
    "atelier": {
      "type": "http",
      "url": "http://127.0.0.1:7717/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}
```

That token belongs to one project. Every workflow, run and asset the agent
touches is inside it, from the first call — there is no question to answer and
no project to choose. Treat the file the way you would treat a password; it is
not a repo file.

> There is also a spawned path — `claude mcp add atelier -- node
> /absolute/path/to/atelier/server/dist/mcp/bin.js` — for a machine that already
> has a checkout and a build. It offers exactly the same tools. Without a token
> to say where it is, a session there asks which project to work in when there
> is more than one.

`docker-compose.yaml` publishes the port to **`127.0.0.1` on the host and
nowhere else**, and that is the security posture rather than a default worth
changing. Inside a container loopback means the container, so the daemon binds
`0.0.0.0` there and its own loopback check stands down; what keeps it private is
the publish binding. Widen it to `7717:7717` and you have put a browser-driving
API on the network.

## Building a workflow

You are not recorded. You **state** each step, and Atelier performs it.

1. Open the site, click the Atelier icon, hit **Record a workflow**. The popup
   closes and an orange **A** appears over the page. Name the workflow there.
2. **Point at an element.** Atelier suggests what to call it — a button's text,
   a field's placeholder — and you confirm or change it. That name is both what
   the step is called and, when it still finds the element, how the step finds
   it.
3. **Choose an action.** The list is the actions *that element* can take: click
   a button, type into a field, tick a checkbox, choose an option, capture an
   image, wait for something to appear or go away.
4. **Add step.** Atelier performs it. The page moves on exactly as it would on a
   real run, and you point at the next thing.

Repeat until you have captured the result. Then **Save workflow** — which asks
one last thing, **what it is for** — and activate it from the popup or the
dashboard.

**Why that question.** Everything else a workflow carries says what it *does*,
and your agent reads all of it: the steps, the inputs, what it produces. None of
it says whether this is the right thing to call. That one line is the only thing
that does, and you are the only one who can write it. It is skippable, and an
undescribed workflow says so rather than pretending — on its dashboard page, and
to the agent, which is told to write one with `describe_workflow` once it works
out what the thing is good for.

**Why Atelier does the clicking.** Add step runs the step through the same
executor that will replay it later. A step that cannot be performed is refused
while you are still looking at the page and can point at something else — rather
than being discovered on the first run a week later.

**The panel can be dragged out of the way** by its launcher, and cannot be
dragged off the screen. Collapsed it is one small square; clicking it opens the
whole panel, which is about nine tenths of the window tall.

**It stays on top of the site's own overlays.** A modal or a sheet opened by the
page paints in the browser's top layer, above every z-index there is, so Atelier
is in the top layer too — and when a site opens a *modal* dialog, which nothing
can be above from outside, the panel moves inside it. Move the mouse and it
comes back to the front on its own.

**Anything you type is kept, and you say who supplies it.** A value is
**always this** — replayed exactly, and never shown to the agent at all — or
**the agent supplies it**, which makes it a named input. Either way the text you
typed is stored, because that is what a **test run** types.

**Two fields cannot ask for the same value.** Names are compared as they will be
written down, so "Same text", "SAME Text" and "same_text" are one name — the
agent passes one value per name, and two fields sharing one would both get it.
Atelier says so when you add the step, while renaming is still free.

**While recording, steps cannot be removed one at a time, and an action can
never be changed.** A step list you can edit in the middle stops describing
anything that was actually performed, and that it describes exactly what was
performed is the whole value of the thing. **Start over** is the escape hatch
and says what it costs.

Once a workflow is *saved*, a step that should not be there **can** be removed
from its page on the dashboard — a stray click, a wait the site no longer needs.
The alternative would be re-recording the other nineteen. What a step does still
cannot be changed anywhere: a step nobody performed is a step nobody checked.

**Passwords are never recorded** — not the value, and not as part of a selector.
A password field offers exactly one action: park the job and hand you the
keyboard.

## What replay does about a page that changes

Every step has a patience budget. Replay tries each selector the step carries,
best first; if none of them resolves, it looks again a fraction of a second
later, until the timeout runs out. That is the whole mechanism — there is no
observer to register and nothing to configure, because a step whose element is
not there yet and one whose element is about to appear are the same situation
and waiting handles both.

Ordinary steps get 30 seconds. A capture gets three minutes, because generating
something is the slow thing this tool exists for.

**And a workflow pauses between steps** — one second by default, and one second
is also the minimum. That is a different thing from waiting for an element:
anything that can be waited *for* is already covered above. The pause is for
what cannot be — a framework re-rendering, a handler running on the next tick,
an animation finishing so a click lands where it looks like it will. Raise it on
a workflow's own page for a site that is visibly slower to settle.

## When a workflow starts to rot

Replay tries every selector it carries, best first, and uses whichever resolves.
That is what carries a workflow through a redeploy — and it is also what hides
one, because a step quietly matching on its position in the page looks exactly
like a step matching on a stable test id, right up until the layout moves too.

So replay reports which candidate won, and Atelier compares it to the one the
step was recorded against. `workflow_health`, the popup and the workflow's own
page say what is decaying and how badly, before it breaks. When something has
moved, **repoint** that one step from the popup — the other nineteen were fine,
and repointing changes only where the step looks, never what it does.

## Where to look

**`http://127.0.0.1:7717`** — the dashboard. It updates live; there is nothing
to refresh.

Everything below the header belongs to **one project**, named in the switcher at
the top right. **Overview** opens with a little of everything — health, run
success and assets as three figures, runs over the last fortnight, outcomes, and
the top of each list. Then **Workflows**, **Runs**, **Assets** and **Connect**
for the detail.

**Every workflow has its own page**: what it is for — editable, because the
answer usually gets better after a few runs — then every step with what it acts
on, what it does and what it types, what each step is currently matching on, and the four
things you can do to it — test it, activate it, disable it, delete it.
Disabling keeps everything and makes it invisible to the agent, which is what
you want when a site has changed and you have not fixed it yet. The Atelier
popup links straight here.

Two things are never behind a section: **a parked job and a detached browser.**
Those are the states where Atelier is stuck waiting on a person. Counts sit on
the nav so nothing has to be opened to be noticed, and the section lives in the
URL so a reload — or a link — puts you back where you were.

**Assets are clickable.** Full size, the prompt that made it, and a
**description** you can write: what the asset actually *shows*, as opposed to
what was asked for. That field is the one anything choosing between assets later
has to go on — including an agent, which reads `list_assets` rather than the
pixels — so `describe_asset` writes it and `list_assets` returns it.

The dashboard and the extension popup are deliberately different things. The
**popup** is the action surface: what needs you now, and the workflows recorded
on the page you are looking at. It says how many live elsewhere rather than
listing them, because a list you scan past to find the two that apply costs more
than it gives. The **dashboard** is where everything is, with detail.

If the page will not load at all, the daemon is not running — `docker compose up
-d`, or check `~/.atelier/atelierd.log`.

**After updating Atelier, reload the extension** at `chrome://extensions`. A
manifest change — a new permission, for instance — does not take effect until
you do.

## Projects

Everything Atelier owns — workflows, runs, assets, recordings — belongs to
exactly one project. A fresh install has one called **Default** and you can
ignore all of this; the moment you are doing work for two different places,
split them.

**Each project has its own MCP token**, issued when it is created. That is how
an agent knows where it is working: the `.mcp.json` you dropped beside a
repository carries one project's token, so every call is inside that project
from the start. Issue a new token from the Connect tab to revoke every config
file carrying the old one.

The dashboard has one **active project**, the way `kubectl` has one current
context. The switcher in the header changes it, and it is what the browser
extension records into — the popup says which, so a recording cannot be filed
somewhere nobody is looking without the screen having said so. It does **not**
move an agent session: a session halfway through twenty minutes of work should
not change project because somebody clicked a menu in another window.

Workflow names are unique *per project*, so "the export workflow" is a name you
can have once per client rather than once ever.

## Using it from Claude Code

```
list_projects                 → what projects exist, and where this session is working
use_project   project          → tie this session to one, for the rest of the session
create_project name            → start a new body of work
atelier_status                → where you are, is the daemon up, is anything rotting
list_workflows                → what this project can do
get_workflow  name             → every step, with ids and health
run_workflow  name, inputs     → replay it, wait, return the asset
test_workflow name             → replay it with the values it was recorded with
set_workflow_status name, s    → disable one without losing it, or enable it again
set_step_value name, stepId    → move one value between "always this" and "the agent supplies it"
remove_step   name, stepId     → take one step out of a saved workflow
set_step_delay name, seconds   → how long it settles between steps (one second minimum)
describe_workflow name, text   → say what a workflow is for, once you know
workflow_health [name]         → what each step is matching on now vs. as recorded
repair_step   name, stepId     → fix where one step looks, without touching the rest
list_jobs / job_status         → what ran, what is parked
resume_job / cancel_job        → after the human clears an obstacle
save_asset    id, path         → write the asset into the repo
list_assets                    → reuse instead of regenerate
describe_asset id, description → say what an asset actually shows
list_drafts / get_draft        → the raw recording, for diagnosing a bad workflow
define_workflow / delete_workflow / promote_draft        → hand-write or replace one
```

Check `atelier_status` before `run_workflow`: a workflow with no browser attached
parks and waits for a human, which is slower than saying so up front.

A workflow types whatever string it is handed and applies no house style of its
own. Anything long-form — a prompt, a message body, a search query — is composed
by the caller and passed whole, so where that text comes from stays a property
of your project rather than of Atelier.

**Nothing in the core names a site.** `npm run check:generic` fails the build if
it does. A general tool that knows about one particular service is a tool that
only really works for whoever wrote it, and the drift is invisible — the logic
stays correct while the words around it rot.

## When something goes wrong

A job that hits a login wall, a captcha, a changed page, or a closed browser does
not fail — it **parks**. You get one notification, the popup shows what it needs,
and **Resume** retries the exact step it stopped on. Claude is told to wait
rather than retry.

That is the whole error model. There is no retry configuration, because the only
sensible retry is a human looking at the screen.

## What is deliberately absent

- **No settings page.** Ports are probed, profiles are detected, timeouts are
  worked out when a workflow is saved. Nothing that can be derived is asked.
- **No inference about what you meant.** You say what each step acts on, what it
  does, and who supplies its value. Nothing is guessed from a trace, because a
  trace does not contain intent.
- **No review queue.** A recording becomes a workflow the moment it is saved. You
  activate it; you are never asked to go and prompt something else to finish it.
- **No cloud.** The daemon binds `127.0.0.1`. Assets never leave the machine
  unless you copy them into a repo.
- **No unscoped automation.** Every workflow carries an origin allowlist and
  replay refuses to act outside it.

See `docs/architecture.md` for how it fits together, and `docs/security.md` for
what this can and cannot do.
