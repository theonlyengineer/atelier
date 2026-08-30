/**
 * The dashboard, in a real browser, against a real daemon.
 *
 * Splitting a page into tabs is only an improvement if it never hides the thing
 * you opened the page to find, and never moves under the reader while they are
 * reading. Both are easy to get wrong and neither is visible in a screenshot,
 * so both are pinned here.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ATELIER_HOME = mkdtempSync(join(tmpdir(), 'atelier-dash-'))
const PORT = 7798

const CHROME = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p))

const { startDaemon } = await import('../src/daemon.ts')
const repo = await import('../src/db/repo.ts')

let stop: (() => void) | null = null
let browser: any = null

before(async () => {
  const d = await startDaemon(PORT)
  stop = d.close

  // One workflow that has decayed, one waiting to be activated: the two states
  // the tabs and badges exist to surface.
  const decayed = repo.saveWorkflow({
    name: 'decayed-workflow',
    description: 'test',
    status: 'active',
    origins: ['https://a.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    steps: [
      {
        id: 'd1',
        kind: 'click',
        note: 'Click Export',
        timeoutMs: 15000,
        selectors: [
          { strategy: 'testid', value: '[data-testid="x"]', score: 98 },
          { strategy: 'xpath', value: '/html/body/button', score: 30 },
        ],
      },
    ],
  } as never)
  repo.recordStepMatch(decayed.id, 'd1', 'xpath', 30)

  repo.saveWorkflow({
    name: 'pending-workflow',
    description: 'test',
    status: 'draft',
    origins: ['https://b.test'],
    profileId: null,
    inputs: [],
    produces: 'image',
    steps: [
      { id: 'p1', kind: 'click', note: 'Click Go', timeoutMs: 15000, selectors: [{ strategy: 'id', value: '#g', score: 92 }] },
    ],
  } as never)

  if (!CHROME) return
  const puppeteer = (await import('puppeteer-core')).default
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
  })
})

after(async () => {
  await browser?.close()
  stop?.()
})

const skip = { skip: CHROME ? false : 'no Chrome on this machine' }

async function open() {
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 900 })
  // networkidle would never fire: the dashboard holds an SSE connection open.
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(`document.querySelectorAll('.kpi').length > 0`, { timeout: 8000 })
  return page
}

const selected = (page: any) =>
  page.evaluate(`document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab`)

test('the dashboard opens on the overview, which shows a little of everything', skip, async () => {
  const page = await open()
  assert.equal(await selected(page), 'overview')
  // The point of an overview is that the first screen answers the question
  // rather than asking which section you wanted.
  assert.equal(await page.evaluate(`document.querySelectorAll('.kpi').length`), 3)
  assert.ok(await page.evaluate(`!!document.querySelector('#chart-runs svg')`), 'a runs chart')
  assert.ok(await page.evaluate(`!!document.querySelector('#chart-donut svg')`), 'an outcomes chart')
  assert.ok(await page.evaluate(`document.querySelectorAll('#ov-workflows .row').length > 0`), 'a workflow summary')
  assert.equal(
    await page.evaluate(`[...document.querySelectorAll('[role="tabpanel"]')].filter(p => !p.hidden).length`),
    1,
  )
  await page.close()
})

test('anything that needs a human stays visible on every tab', skip, async () => {
  // The whole risk of tabbing a status page: putting the reason you opened it
  // behind a click. A parked job and a detached browser never move.
  const page = await open()
  for (const tab of ['overview', 'workflows', 'runs', 'assets', 'log']) {
    await page.evaluate(`location.hash = '#${tab}'`)
    await new Promise((r) => setTimeout(r, 100))
    const shown = await page.evaluate(
      `(() => { const el = document.querySelector('#attention > *'); return !!el && el.offsetHeight > 0 })()`,
    )
    assert.equal(shown, true, `the attention band must be visible on #${tab}`)
  }
  await page.close()
})

test('a state is stated once, with the fix in one place', skip, async () => {
  // The old page reported a detached browser in a stat card, a banner and a
  // section — three sightings, no extra information, which teaches a reader
  // that none of the three is worth reading. The pill summarises; the band
  // carries the instruction; nothing else repeats either.
  const page = await open()
  const instructions = await page.evaluate(
    `document.body.innerText.split('chrome://extensions').length - 1`,
  )
  assert.equal(instructions, 1, 'the fix should appear exactly once')
  assert.equal(
    await page.evaluate(`document.querySelectorAll('#attention > *').length`),
    1,
    'one attention card for one problem',
  )
  await page.close()
})

test('the sidebar says what state the whole system is in', skip, async () => {
  const page = await open()
  const status = await page.evaluate(
    `(() => { const el = document.querySelector('#sidestat'); return { cls: el.className, text: el.innerText.trim() } })()`,
  )
  // No browser is attached in this fixture, so it is a warning, not "Ready".
  assert.match(status.cls, /warn/)
  assert.match(status.text, /browser/i)
  await page.close()
})

test('run history is aggregated, not enumerated', skip, async () => {
  // Eight rows reading "generate-image · done · 2d ago" is a log wearing a
  // summary's clothes. Twelve runs must render as one row, not twelve.
  const decayed = repo.getWorkflowByName('decayed-workflow')!
  for (let i = 0; i < 12; i++) {
    const job = repo.createJob(decayed.id, {}, 1)
    repo.updateJob(job.id, { status: i === 5 ? 'failed' : 'done' })
  }

  const page = await open()
  await page.evaluate(`location.hash = '#runs'`)
  await page.waitForFunction(`document.querySelectorAll('#recent .row').length > 0`, { timeout: 8000 })

  const rows = await page.evaluate(`document.querySelectorAll('#recent .row').length`)
  assert.equal(rows, 1, '12 runs of one workflow is one row')
  const text = await page.evaluate(`document.querySelector('#recent').innerText`)
  assert.match(text, /12 runs/)
  // The pill is uppercased in CSS, and innerText reports the transformed text.
  assert.match(text, /1 failed/i)
  await page.close()
})

test('a live state frame does not snap the tab back under the reader', skip, async () => {
  // render() runs on every change and every 25 seconds regardless. Deriving the
  // visible tab from that data is the classic way a live page becomes unusable.
  const page = await open()
  await page.evaluate(`location.hash = '#log'`)
  await new Promise((r) => setTimeout(r, 100))

  // Provoke a state push by mutating through the API.
  await page.evaluate(
    `fetch('/api/workflows.activate', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'pending-workflow'})})`,
  )
  await new Promise((r) => setTimeout(r, 1000))

  assert.equal(await selected(page), 'log')
  await page.close()
})

test('the tab in the URL is the tab you get back on reload', skip, async () => {
  const page = await open()
  await page.evaluate(`document.querySelector('[data-tab="assets"]').click()`)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(await page.evaluate('location.hash'), '#assets')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(`document.querySelectorAll('.nav button').length > 0`, { timeout: 8000 })
  assert.equal(await selected(page), 'assets')
  await page.close()
})

test('a tab carries a count, so nothing has to be opened to be noticed', skip, async () => {
  // The only thing that makes hiding a section acceptable.
  const page = await open()
  const badge = await page.evaluate(
    `(() => { const b = document.querySelector('#badge-workflows'); return { hidden: b.hidden, text: b.textContent } })()`,
  )
  assert.equal(badge.hidden, false)
  // One decayed workflow plus however many are still awaiting activation.
  assert.ok(Number(badge.text) >= 1, 'the workflows badge should count what needs attention')
  await page.close()
})

test('the tablist is keyboard navigable', skip, async () => {
  const page = await open()
  await page.focus('#tab-overview')
  await page.keyboard.press('ArrowDown')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(await selected(page), 'workflows')
  await page.keyboard.press('ArrowUp')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(await selected(page), 'overview')
  await page.close()
})

test('an unknown hash falls back rather than showing nothing', skip, async () => {
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${PORT}/#nonsense`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(`document.querySelectorAll('.kpi').length > 0`, { timeout: 8000 })
  assert.equal(await selected(page), 'overview')
  assert.equal(
    await page.evaluate(`[...document.querySelectorAll('[role="tabpanel"]')].filter(p => !p.hidden).length`),
    1,
  )
  await page.close()
})

/* ------------------------------------------------------------- assets */

test('an asset opens full size, and its description can be written from the page', skip, async () => {
  // A description is what anything choosing between assets later has to go on —
  // an agent picking one to reuse, or a person scanning a grid of nine
  // near-identical thumbnails. It has to be editable where you are looking at
  // the thing.
  const assets = await import('../src/core/assets.ts')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8//8/AzGAiShVowaOGggATgcEAWyfHBcAAAAASUVORK5CYII=',
    'base64',
  )
  const stored = assets.store(png, { mime: 'image/png', prompt: 'a test pattern' })

  const page = await open()
  await page.evaluate(`location.hash = '#assets'`)
  await page.waitForFunction(`document.querySelectorAll('#assets [data-asset]').length > 0`, { timeout: 8000 })

  // Until it has one, the card says so rather than showing a blank line.
  assert.match(await page.evaluate(`document.querySelector('#assets').innerText`), /No description yet/)

  await page.evaluate(`document.querySelectorAll('#assets [data-asset]')[0].click()`)
  await page.waitForFunction(`document.querySelector('#viewer').open`, { timeout: 4000 })

  // The full-size image, not the thumbnail.
  assert.match(await page.evaluate(`document.querySelector('#v-img').src`), /\/asset\//)
  assert.match(await page.evaluate(`document.querySelector('#v-prompt').innerText`), /test pattern/)

  await page.type('#v-desc', 'A small black and white test pattern.')
  await page.click('#v-save')
  await new Promise((r) => setTimeout(r, 600))

  const saved = repo.getAsset(stored.id)!
  assert.equal(saved.description, 'A small black and white test pattern.')
  await page.close()
})

test('a description survives the round trip and reaches anything listing assets', skip, async () => {
  // The reason this field exists: an agent reads the list, not the pixels.
  const listed = repo.listAssets(50).filter((a) => a.description)
  assert.ok(listed.length > 0, 'at least one asset should carry a description')
  assert.ok(
    listed.every((a) => typeof a.description === 'string' && a.description.length > 0),
    'a stored description must come back as text, not an empty string',
  )
})

test('clearing a description empties it rather than storing whitespace', skip, async () => {
  const assets = await import('../src/core/assets.ts')
  const a = assets.store(Buffer.from('bytes-for-clearing'), { mime: 'image/png' })
  repo.setAssetDescription(a.id, 'something')
  assert.equal(repo.getAsset(a.id)!.description, 'something')
  repo.setAssetDescription(a.id, '   ')
  assert.equal(repo.getAsset(a.id)!.description, null)
})
