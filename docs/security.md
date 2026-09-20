# Security posture

Atelier replays recorded actions in a browser that is signed into your accounts.
That is the feature and it is also the risk, so the boundaries are worth stating
plainly.

## What is enforced

**Loopback only.** The daemon binds `127.0.0.1` and rejects any request whose
remote address is not loopback. Nothing is reachable from the network.

Inside a container loopback means the container, so the daemon binds `0.0.0.0`
there and stands its own address check down — and the supplied compose file puts
the boundary back by publishing the port to the *host's* loopback rather than to
every interface. Widening that publish is the one edit in this project that
turns a local tool into a network service.

**A token per project, and it is the scope as well as the key.** Every project
is issued a token when it is created. `/mcp` resolves the presented token to a
project and binds the session to it before the agent's first call; a token that
matches nothing is refused with no fallback to whatever the dashboard happens to
be showing. So a leaked config file is access to one project, not to the
machine, and revoking is issuing a new token for that project from the Connect
tab.

The token is never in the dashboard's HTML. It is fetched by the Connect tab,
for one project, when somebody opens it — a page left in a tab all day should
not have the credential sitting in a document anything can read.

`/mcp.json` is the one response that never carries
`access-control-allow-origin`. Every other one does, for the extension. On the
response containing a credential, that wildcard would let any page you visit
read it and drive your browser through it. `authorization` is likewise kept out
of `access-control-allow-headers`, so no page can even preflight a token-bearing
request. Neither omission is an oversight to tidy up.

**Site access is granted per origin, by the browser.** The extension ships with
no host permissions beyond loopback. When you start recording on a site, Chrome
asks for that one origin; replay refuses, and the job parks with a readable
reason, if the origin was never granted. This used to be `<all_urls>` in the
manifest — the daemon enforced the allowlist, but the browser had already handed
the extension the whole web, and the permission prompt is the part a careful
person actually reads.

**Origin allowlist per workflow.** Every workflow names the origins it may act
on, and the daemon re-sends that list with every step so a stale extension
cannot widen its own scope. A workflow recorded on an image generator cannot act
on your bank, even if the step list is edited to try.

**Passwords are never recorded.** Point at a password field and Atelier offers
exactly one action: stop and hand you the keyboard. That is not a filter that
happens to come out that way — it is an explicit stop, because "capture its
text" and "capture its placeholder" both applied on the way through and either
would have written the secret into an asset by a route that has nothing to do
with the recorder carefully not storing the value.

That covers the *selectors* too, which it did not always. A selector candidate
is built from an element's accessible name, and for an input that name used to
fall back to `el.value` — so a password field produced the candidate
`textbox:<the password>`. A field's current contents are never part of its
identity now: they change between runs, so a selector built on them is broken by
definition, quite apart from the leak. Covered by a test that types a password
and asserts the string appears nowhere in what was captured.

**A static value is never shown to the agent.** Marking a value "always this"
means it is setup: replayed exactly, absent from the workflow's declared inputs,
and not reported by any MCP tool. An API key typed once into a settings field
stays between you and the site.

**Assets stay local.** Blobs live under `~/.atelier` and only leave when
`save_asset` copies one into a path you asked for.

## What is not defended against

**A workflow you approved.** Nothing reaches `active` without a human pressing
Activate, and the workflow's own page shows every step with what it acts on and
what it types. If you activate without reading it, it runs.

**Anything with local code execution.** A process on your machine can read
`~/.atelier/atelier.db` and with it every project token. This is the same trust
model as the Docker socket: local access is full access. The database is 0600,
which is about other users on a shared machine, not about processes running as
you.

**A compromised extension or browser.** Atelier drives the browser; it does not
sandbox it.

## Practical advice

Keep origin lists to exactly the site involved — one origin, not a wildcard.
Read a workflow's page before activating it, particularly the steps that touch
anything destructive. Mark anything that is a credential as "always this" so it
never becomes an input. And if a workflow ever needs a password, let it park and
type it yourself; that path is deliberately the easy one.
