# Security posture

Atelier replays recorded actions in a browser that is signed into your accounts. That is
the feature and it is also the risk, so the boundaries are worth stating plainly.

## What is enforced

**Loopback only.** The daemon binds `127.0.0.1` and rejects any request whose remote
address is not loopback. Nothing is reachable from the network.

**Site access is granted per origin, by the browser.** The extension ships with no host
permissions beyond loopback. When you start recording on a site, Chrome asks for that
one origin; replay refuses, and the job parks with a readable reason, if the origin was
never granted. This used to be `<all_urls>` in the manifest — the daemon enforced the
allowlist, but the browser had already handed the extension the whole web, and the
permission prompt is the part a careful person actually reads.

**Origin allowlist per workflow.** Every workflow names the origins it may act on, and
the daemon re-sends that list with every step so a stale extension cannot widen its own
scope. A workflow recorded on an image generator cannot act on your bank, even if the
step list is edited to try.

**Passwords are never recorded.** The recorder drops the value of any `password` or `otp`
field and marks the step `manual`, which parks the job for you. This is a correctness
property as much as a security one: a replay that types a stale password is worse than
one that stops.

That covers the *selectors* too, which it did not always. A selector candidate is built
from an element's accessible name, and for an input that name used to fall back to
`el.value` — so a password field produced the candidate `textbox:<the password>`. The
recorder was careful to drop the typed value and then wrote it into a selector instead.
A field's current contents are never part of its identity now: they change between runs,
so a selector built on them is broken by definition, quite apart from the leak. Covered
by a test that types a password and asserts the string appears nowhere in what was
captured.

**Assets stay local.** Blobs live under `~/.atelier` and only leave when `save_asset`
copies one into a path you asked for.

## What is not defended against

**A malicious workflow you approved.** The review pass is where a bad step gets caught.
If you promote a draft without reading it, it runs.

**Anything with local code execution.** A process on your machine can reach the daemon,
because loopback is the only boundary. This is the same trust model as the Docker socket:
local access is full access.

**A compromised extension or browser.** Atelier drives the browser; it does not sandbox
it.

## Practical advice

Keep origin lists to exactly the site involved — one origin, not a wildcard. Read
`get_draft` output before promoting it, particularly the steps that touch anything
destructive. And if a workflow ever needs a credential, let it park and type the
credential yourself; that path is deliberately the easy one.
