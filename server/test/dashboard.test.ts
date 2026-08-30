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

test('a workflow name is readable in the overview, not squeezed to one letter', skip, async () => {
  // A grid column is minmax(auto, …) by default, so a child that refuses to
  // shrink — the horizontally-scrolling asset strip next door — eats the row and
  // collapses its neighbour. `generate-image` rendered as "g".
  const page = await open()
  const names = await page.evaluate(
    `[...document.querySelectorAll('#ov-workflows .row .k')].map(e => ({
       text: e.textContent, width: Math.round(e.getBoundingClientRect().width) }))`,
  )
  assert.ok(names.length > 0, 'the overview should list workflows')
  for (const n of names) {
    assert.ok(n.width > 60, `"${n.text}" got ${n.width}px, which cannot show a name`)
  }
  await page.close()
})

test('the dashboard is light even when the operating system is dark', skip, async () => {
  // A dark variant was invented that the house style does not have, so anyone
  // with a dark OS — most people — got a dashboard that looked nothing like the
  // thing it is supposed to match. Light is the whole theme; this is the test
  // that stops it drifting back.
  const page = await browser.newPage()
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(`document.querySelectorAll('.kpi').length > 0`, { timeout: 8000 })

  const bg = await page.evaluate(`getComputedStyle(document.body).backgroundColor`)
  assert.equal(bg, 'rgb(255, 251, 245)', 'the paper colour, regardless of the OS setting')

  const ink = await page.evaluate(`getComputedStyle(document.body).color`)
  assert.equal(ink, 'rgb(0, 0, 0)', 'ink stays ink')
  await page.close()
})

test('no dark-mode block survives anywhere in the page', skip, async () => {
  // Belt and braces: a component-level override would reintroduce the same bug
  // one card at a time, and the computed-style check above would not catch it.
  const res = await fetch(`http://127.0.0.1:${PORT}/`)
  const html = await res.text()
  assert.equal(
    html.includes('prefers-color-scheme'),
    false,
    'the house style is light only — a dark block here means the dashboard stops matching it',
  )
})

test('the asset viewer fits and stays reachable at any window size', skip, async () => {
  // Two bugs lived here, both from the same root: a grid item defaults to
  // min-height:auto, so it will not shrink below its content. The metadata
  // column therefore never scrolled — its overflow:auto had nothing to act on —
  // and the parent's max-height simply clipped it, putting Save out of reach.
  // The image, meanwhile, was bounded by the viewport rather than by its own
  // stage, so a tall one hung out of the bottom of the dialog.
  const assets = await import('../src/core/assets.ts')

  // A deliberately tall image and a long description: the shapes that break it.
  // A genuine 180x900 PNG. A malformed one decodes to zero and then renders at
  // zero in the stacked layout, which looks exactly like the collapse this test
  // is here to catch — a fixture that fakes the bug is worse than no fixture.
  const tall = assets.store(Buffer.from('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', 'base64'), {
    mime: 'image/png',
    prompt: 'a very tall test pattern',
  })
  repo.setAssetDescription(
    tall.id,
    'A tall test pattern. This description is long on purpose so the metadata column has to scroll. '.repeat(8),
  )

  for (const [w, h] of [
    [1360, 900], // roomy
    [1280, 420], // short — where the clipping showed
    [700, 800], // narrow — where the layout stacks
  ]) {
    const page = await browser.newPage()
    await page.setViewport({ width: w, height: h })
    await page.goto(`http://127.0.0.1:${PORT}/#assets`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(`document.querySelectorAll('#assets [data-asset]').length > 0`, { timeout: 8000 })
    await page.evaluate(`document.querySelectorAll('#assets [data-asset]')[0].click()`)
    await page.waitForFunction(`document.querySelector('#viewer').open`, { timeout: 4000 })
    await new Promise((r) => setTimeout(r, 500))

    const m = (await page.evaluate(`(() => {
      const v = document.querySelector('.viewer')
      const st = document.querySelector('.stage')
      const img = document.querySelector('#v-img')
      const meta = document.querySelector('.meta')
      const save = document.querySelector('#v-save')
      const R = e => e.getBoundingClientRect()
      return {
        imgOverflows: R(img).bottom > R(st).bottom + 1 || R(img).right > R(st).right + 1,
        // Non-zero, not "large": in the stacked layout the element is the image
        // itself at its natural size, and the fixture is deliberately tiny. In
        // the two-column layout the element is inset to the stage and the
        // picture is letterboxed inside it by object-fit, so its box is the
        // stage's — which is exactly the property being guarded.
        imgHasSize: R(img).height > 0 && R(img).width > 0,
        overflowing: R(meta).bottom > R(v).bottom + 2,
        metaScrolls: meta.scrollHeight > meta.clientHeight + 1,
        viewerScrolls: v.scrollHeight > v.clientHeight + 1,
        saveInDialog: R(save).bottom <= R(v).bottom + 2 || v.scrollHeight > v.clientHeight + 1,
      }
    })()`)) as Record<string, boolean>

    const at = `${w}x${h}`
    assert.equal(m.imgOverflows, false, `${at}: the image must stay inside its stage`)
    assert.equal(m.imgHasSize, true, `${at}: the image must not collapse to nothing`)
    // If anything hangs past the bottom, something has to be able to scroll to it.
    if (m.overflowing) {
      assert.ok(m.metaScrolls || m.viewerScrolls, `${at}: content overflows with nothing to scroll`)
    }
    assert.equal(m.saveInDialog, true, `${at}: Save must be reachable`)
    await page.close()
  }
})
