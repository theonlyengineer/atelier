/**
 * The one guard that needs a database of its own to test: you cannot delete the
 * last project. Everything else about projects is in projects.test.ts, which by
 * the time it runs has several and cannot get back to one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ATELIER_HOME = mkdtempSync(join(tmpdir(), 'atelier-lastproject-'))

const repo = await import('../src/db/repo.ts')

test('the only project cannot be deleted — there has to be somewhere to be', () => {
  const all = repo.listProjects()
  assert.equal(all.length, 1, 'a fresh database starts with exactly one')

  // Move off it first, so the "cannot delete the active one" guard is not what
  // fires — this is specifically about being the last.
  const spare = repo.createProject('Spare')
  repo.setActiveProject(spare.id)
  repo.deleteProject(all[0]!.id)

  assert.equal(repo.listProjects().length, 1)
  assert.throws(() => repo.deleteProject(spare.id), /only|last/i)
})
