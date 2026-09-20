/**
 * Projects.
 *
 * Everything Atelier owns — workflows, runs, assets, recordings — belongs to
 * exactly one project.
 *
 * The daemon holds one *active* project, the way kubectl holds one current
 * context. That is what the dashboard switcher changes and what the browser
 * extension records into, and it is shared rather than per-tab because those two
 * surfaces have to agree about where a recording lands.
 *
 * An agent session is different and is handled a layer up, in the MCP process:
 * it binds to a project of its own and asks the human when it cannot tell.
 * Deliberately not "follow whatever the dashboard is showing" — an agent doing
 * twenty minutes of work should not change project because somebody clicked a
 * menu in another window.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ATELIER_HOME = mkdtempSync(join(tmpdir(), 'atelier-projects-'))

const repo = await import('../src/db/repo.ts')
const db = await import('../src/db/index.ts')
const assets = await import('../src/core/assets.ts')

const wf = (name: string, projectId?: string) =>
  repo.saveWorkflow({
    name,
    description: '',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    steps: [{ id: 's', kind: 'click', selectors: [{ strategy: 'id', value: '#a', score: 92 }], timeoutMs: 1000 }],
    ...(projectId ? { projectId } : {}),
  } as never)

/* ------------------------------------------------------------ the default */

test('a fresh install has exactly one project, and it is active', () => {
  const all = repo.listProjects()
  assert.equal(all.length, 1)
  assert.equal(all[0]!.slug, 'default')
  assert.equal(repo.activeProject().id, all[0]!.id)
})

test('there is always an active project — nothing can be scoped to nowhere', () => {
  assert.ok(repo.activeProject(), 'never null')
})

/* ------------------------------------------------------------- creating */

test('creating a project slugifies its name and returns it', () => {
  const p = repo.createProject('Client Work')
  assert.equal(p.name, 'Client Work')
  assert.equal(p.slug, 'client-work')
  assert.equal(repo.listProjects().length, 2)
})

test('creating does not switch to it — moving is a separate, deliberate act', () => {
  const before = repo.activeProject().id
  repo.createProject('Somewhere Else')
  assert.equal(repo.activeProject().id, before)
})

test('two projects cannot share a slug', () => {
  repo.createProject('Duplicate Name')
  assert.throws(() => repo.createProject('duplicate name'), /already/i)
})

test('a project needs a name', () => {
  assert.throws(() => repo.createProject('   '), /name/i)
})

/* ------------------------------------------------------------- scoping */

test('a workflow belongs to the project that was active when it was made', () => {
  const client = repo.createProject('Scoping A')
  repo.setActiveProject(client.id)
  const made = wf('scoped-workflow')
  assert.equal(made.projectId, client.id)
})

test('listing only shows the active project, which is the whole point', () => {
  const a = repo.createProject('Only A')
  const b = repo.createProject('Only B')

  repo.setActiveProject(a.id)
  wf('lives-in-a')
  repo.setActiveProject(b.id)
  wf('lives-in-b')

  assert.deepEqual(repo.listWorkflows().map((w) => w.name), ['lives-in-b'])
  repo.setActiveProject(a.id)
  assert.deepEqual(repo.listWorkflows().map((w) => w.name), ['lives-in-a'])
})

test('the same workflow name can exist in two projects', () => {
  // The old schema made name globally unique, which would make "the export
  // workflow" a name you can only have once across every client you work for.
  const a = repo.createProject('Same Name A')
  const b = repo.createProject('Same Name B')

  repo.setActiveProject(a.id)
  const first = wf('export-invoices')
  repo.setActiveProject(b.id)
  const second = wf('export-invoices')

  assert.notEqual(first.id, second.id)
  assert.equal(repo.getWorkflowByName('export-invoices')!.id, second.id, 'resolves within the active project')
})

test('a name lookup cannot reach into another project', () => {
  const a = repo.createProject('Reach A')
  const b = repo.createProject('Reach B')
  repo.setActiveProject(a.id)
  wf('only-in-a')
  repo.setActiveProject(b.id)
  assert.equal(repo.getWorkflowByName('only-in-a'), null)
})

test('assets are scoped too, so a gallery shows one project at a time', () => {
  const a = repo.createProject('Assets A')
  const b = repo.createProject('Assets B')

  repo.setActiveProject(a.id)
  assets.store(Buffer.from('asset-in-a'), { mime: 'image/png', description: 'in a' })
  repo.setActiveProject(b.id)
  assets.store(Buffer.from('asset-in-b'), { mime: 'image/png', description: 'in b' })

  assert.deepEqual(repo.listAssets(50).map((x) => x.description), ['in b'])
  repo.setActiveProject(a.id)
  assert.deepEqual(repo.listAssets(50).map((x) => x.description), ['in a'])
})

test('runs are scoped, so history and charts do not mix clients together', () => {
  const a = repo.createProject('Runs A')
  const b = repo.createProject('Runs B')

  repo.setActiveProject(a.id)
  const wa = wf('runner-a')
  repo.createJob(wa.id, {}, 1)

  repo.setActiveProject(b.id)
  assert.equal(repo.listJobs().length, 0, 'B has no runs of its own')
  repo.setActiveProject(a.id)
  assert.equal(repo.listJobs().length, 1)
})

test('a job inherits its project from the workflow, not from whatever is active later', () => {
  // A long run must not change project because somebody switched the dashboard
  // while it was in flight.
  const a = repo.createProject('Inherit A')
  const b = repo.createProject('Inherit B')
  repo.setActiveProject(a.id)
  const w = wf('inheriting')
  const job = repo.createJob(w.id, {}, 1)

  repo.setActiveProject(b.id)
  assert.equal(repo.getJob(job.id)!.projectId, a.id)
})

/* ------------------------------------------------------------- renaming */

test('a project can be renamed without moving anything inside it', () => {
  const p = repo.createProject('Before')
  repo.setActiveProject(p.id)
  wf('survives-rename')

  const renamed = repo.renameProject(p.id, 'After')
  assert.equal(renamed.name, 'After')
  assert.equal(renamed.id, p.id, 'the id is stable, so nothing inside has to move')
  assert.deepEqual(repo.listWorkflows().map((w) => w.name), ['survives-rename'])
})

/* ------------------------------------------------------------- deleting */

test('a project holding work is not deleted by accident', () => {
  const p = repo.createProject('Has Work')
  const elsewhere = repo.createProject('Somewhere To Stand')
  repo.setActiveProject(p.id)
  wf('something-valuable')
  // Stand somewhere else first, so it is the not-empty guard being tested and
  // not the active-project one, which fires earlier.
  repo.setActiveProject(elsewhere.id)

  assert.throws(() => repo.deleteProject(p.id), /not empty/i)
  assert.throws(() => repo.deleteProject(p.id), /1 workflows/)
})

test('an empty project deletes cleanly', () => {
  const p = repo.createProject('Empty One')
  assert.equal(repo.deleteProject(p.id), true)
  assert.equal(repo.listProjects().some((x) => x.id === p.id), false)
})

test('deleting the active project is refused before it can strand you', () => {
  const p = repo.createProject('Active And Doomed')
  repo.setActiveProject(p.id)
  assert.throws(() => repo.deleteProject(p.id), /active/i)
})

/* --------------------------------------------------------------- tokens */

/**
 * A project's token is what says where an agent is working.
 *
 * It replaced one token for the whole daemon, which got an agent through the
 * door and then left it to ask which room it was in — a question with a wrong
 * answer that nobody notices quickly. Now the credential and the scope are the
 * same fact, so connecting a repository to a project is a copy rather than a
 * decision.
 */

test('every project is born with a token, so connecting one is never a setup step', () => {
  const made = repo.createProject('Tokened')
  assert.ok(made.token.length > 20, 'long enough that guessing is not a strategy')
  assert.notEqual(made.token, repo.listProjects()[0]!.token)
})

test('a token resolves to exactly the project it belongs to', () => {
  const made = repo.createProject('Resolvable')
  assert.equal(repo.projectByToken(made.token)?.id, made.id)
})

test('an unknown token resolves to nothing, rather than to whichever project is active', () => {
  assert.equal(repo.projectByToken('not-a-token'), null)
  assert.equal(repo.projectByToken(''), null)
  assert.equal(repo.projectByToken('   '), null)
})

test('rotating issues a new token and retires the old one — the only way to revoke', () => {
  const made = repo.createProject('Rotatable')
  const before = made.token
  const after = repo.rotateProjectToken(made.id).token
  assert.notEqual(after, before)
  assert.equal(repo.projectByToken(before), null)
  assert.equal(repo.projectByToken(after)?.id, made.id)
})

test('renaming a project leaves its token alone, so no config file breaks', () => {
  const made = repo.createProject('Renamable')
  const before = made.token
  repo.renameProject(made.id, 'Renamed')
  assert.equal(repo.getProject(made.id)?.token, before)
})

/* ---------------------------------------------------- the old recorder */

/**
 * A workflow made before values said who supplied them.
 *
 * Whether the caller supplied a value used to be expressed only by the value
 * happening to be a {{placeholder}}, and a workflow's inputs were a separate
 * list written once. Both are derived from the steps now, so an unmigrated
 * workflow would lose every input it declared the first time anybody edited a
 * value on it — which is the one workflow on the machine, breaking for the
 * agent that has been calling it for weeks.
 */

test('a workflow from before value modes keeps its inputs when one is edited', () => {
  const before = repo.saveWorkflow({
    name: 'from-the-old-recorder',
    description: 'test',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [{ name: 'prompt', description: 'the prompt', required: true }],
    produces: 'image',
    steps: [
      { id: 'n', kind: 'navigate', selectors: [], value: 'https://x.test/', timeoutMs: 30000 },
      // No valueMode, no sampleValue, no target — exactly what was stored.
      {
        id: 'typed',
        kind: 'type',
        selectors: [{ strategy: 'id', value: '#p', score: 92 }],
        value: '{{prompt}}',
        timeoutMs: 15000,
      },
      {
        id: 'fixed',
        kind: 'type',
        selectors: [{ strategy: 'id', value: '#s', score: 92 }],
        value: 'be terse',
        timeoutMs: 15000,
      },
    ],
  } as never)

  // Reopening is what runs the backfill, the way a daemon start would.
  db.close()
  db.open()

  const after = repo.getWorkflow(before.id)!
  const dynamic = after.steps.find((s) => s.id === 'typed')!
  assert.equal(dynamic.valueMode, 'dynamic')
  assert.equal(dynamic.inputName, 'prompt')
  // Never stored, so the honest answer is nothing — the workflow's page says a
  // test run would type nothing, which invites filling it in rather than lying.
  assert.equal(dynamic.sampleValue, '')

  const fixed = after.steps.find((s) => s.id === 'fixed')!
  assert.equal(fixed.valueMode, 'static')
  assert.equal(fixed.sampleValue, 'be terse')

  // And the signature survives the first edit, which is the whole point.
  const edited = repo.setStepValue(after.id, 'fixed', { sampleValue: 'be very terse' })
  assert.deepEqual(
    edited.inputs.map((i) => i.name),
    ['prompt'],
  )
})
