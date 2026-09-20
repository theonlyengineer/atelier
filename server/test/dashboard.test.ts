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

/**
 * Every page this suite opens, so a failing test cannot take the rest with it.
 *
 * A dashboard page holds an SSE connection for as long as it is open, and a
 * test that fails throws before its own page.close(). Six leaked pages is
 * Chrome's per-origin connection cap on HTTP/1.1, at which point the next
 * page load hangs for thirty seconds and fails — so one real failure presented
 * as six, with the five downstream ones pointing nowhere useful.
 */
const opened: any[] = []

after(async () => {
  for (const page of opened) {
    try {
      if (!page.isClosed()) await page.close()
    } catch {
      /* already gone */
    }
  }
  await browser?.close()
  stop?.()
})

const skip = { skip: CHROME ? false : 'no Chrome on this machine' }

async function open() {
  const page = await browser.newPage()
  opened.push(page)
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

test('the sidebar carries the sections of one project and nothing else', skip, async () => {
  // It used to end in a status block reading ":7717 - up 33m - this browser".
  // Every part of that was either invariant, uninteresting, or already said
  // louder somewhere else: a detached browser is an attention card, which the
  // test above pins. What is left at the foot of the column is the version,
  // which is the one thing you genuinely cannot work out by looking.
  const page = await open()
  assert.equal(await page.evaluate(`!!document.querySelector('#sidestat')`), false)

  const tabs = (await page.evaluate(
    `[...document.querySelectorAll('.nav [data-tab]')].map(b => b.dataset.tab)`,
  )) as string[]
  assert.deepEqual(tabs, ['overview', 'workflows', 'runs', 'assets', 'connect'])
  // Projects is the frame, not a section of one project, so it lives up in the
  // header beside the switcher.
  assert.equal(await page.evaluate(`!!document.querySelector('.head [data-tab="projects"]')`), true)
  assert.equal(await page.evaluate(`!!document.querySelector('.head .switcher')`), true)

  const version = await page.evaluate(`document.querySelector('.side-version').textContent`)
  assert.match(version as string, /^v\d/)
  // And not next to the wordmark, where it read as part of the name.
  assert.equal(
    await page.evaluate(`document.querySelector('.brand').textContent.replace(/\\s+/g, ' ').trim()`),
    'A Atelier',
  )
  await page.close()
})

test('the drawer collapses to icons, and remembers that it did', skip, async () => {
  const page = await open()
  const width = () => page.evaluate(`document.querySelector('.side').getBoundingClientRect().width`)
  const open0 = (await width()) as number

  await page.click('#drawer')
  await new Promise((r) => setTimeout(r, 400))
  const closed = (await width()) as number
  assert.ok(closed < open0 / 2, 'collapsed to a strip of icons')
  // Taken out of the layout, not merely hidden: a label that still occupies its
  // row keeps the column as wide as its text and scrolls it sideways.
  assert.equal(
    await page.evaluate(`getComputedStyle(document.querySelector('.nav .label-text')).display`),
    'none',
  )

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(`document.querySelectorAll('.kpi').length > 0`, { timeout: 8000 })
  assert.equal(await page.evaluate(`document.documentElement.dataset.drawer`), 'closed')
  await page.evaluate(`localStorage.removeItem('atelier:drawer')`)
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
  await page.evaluate(`location.hash = '#assets'`)
  await new Promise((r) => setTimeout(r, 100))

  // Provoke a state push by mutating through the API.
  await page.evaluate(
    `fetch('/api/workflows.activate', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'pending-workflow'})})`,
  )
  await new Promise((r) => setTimeout(r, 1000))

  assert.equal(await selected(page), 'assets')
  await page.close()
})

test('there is no log section, and the daemon does not stream its log to the page', skip, async () => {
  // It was a file tailed into a tab. Nobody reading a dashboard wants a log
  // they cannot search, and the payload carried forty lines of it to every
  // open tab on every state change. The file is still on disk, which is where
  // a log belongs.
  const page = await open()
  assert.equal(await page.evaluate(`!!document.querySelector('[data-tab="log"]')`), false)
  assert.equal(await page.evaluate(`!!document.getElementById('panel-log')`), false)
  await page.close()

  const res = await fetch(`http://127.0.0.1:${PORT}/api/overview`, { method: 'POST' })
  const payload = (await res.json()) as { result: Record<string, unknown> }
  assert.equal('log' in payload.result, false)
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
  opened.push(page)
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

test('the dashboard is dark by default, whatever the operating system says', skip, async () => {
  // Dark is the default because this page sits open beside an editor all day.
  // It is not "follow the OS": an unset preference is a preference for dark, and
  // a light OS must not drag the page back.
  for (const os of ['dark', 'light'] as const) {
    const page = await browser.newPage()
    opened.push(page)
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: os }])
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(`document.querySelectorAll('.kpi').length > 0`, { timeout: 8000 })
    assert.equal(
      await page.evaluate(`getComputedStyle(document.body).backgroundColor`),
      'rgb(20, 18, 15)',
      `the dark paper, with the OS set to ${os}`,
    )
    await page.close()
  }
})

test('the switch changes the theme, and shows the one you would get', skip, async () => {
  // A switch labelled with the state it is already in is the oldest confusing
  // control there is, and an icon has the same failure mode as a word. In the
  // dark it offers a sun.
  const page = await open()
  const showing = () =>
    page.evaluate(`(() => {
      const el = document.getElementById('theme')
      const on = [...el.querySelectorAll('svg')].filter(s => getComputedStyle(s).display !== 'none')
      return on.length === 1 ? on[0].getAttribute('class') : 'both or neither: ' + on.length
    })()`)

  assert.equal(await showing(), 'moon')

  await page.evaluate(`document.getElementById('theme').click()`)
  assert.equal(
    await page.evaluate(`getComputedStyle(document.body).backgroundColor`),
    'rgb(255, 251, 245)',
    'the house paper is still there, one click away',
  )
  assert.equal(await showing(), 'sun')

  await page.evaluate(`document.getElementById('theme').click()`)
  assert.equal(await page.evaluate(`getComputedStyle(document.body).backgroundColor`), 'rgb(20, 18, 15)')
  assert.equal(await showing(), 'moon')
  await page.evaluate(`localStorage.removeItem('atelier:theme')`)
  await page.close()
})

test('the header runs from the sidebar to the far edge, with the drawer handle on the boundary', skip, async () => {
  const page = await open()
  const geometry = (await page.evaluate(`(() => {
    const side = document.querySelector('.side').getBoundingClientRect()
    const head = document.querySelector('.head').getBoundingClientRect()
    const handle = document.querySelector('#drawer').getBoundingClientRect()
    const right = document.querySelector('.head-right').getBoundingClientRect()
    return { sideRight: side.right, headLeft: head.left, headRight: head.right,
             handleLeft: handle.left, w: window.innerWidth, rightLeft: right.left }
  })()`)) as Record<string, number>

  assert.ok(Math.abs(geometry.headLeft! - geometry.sideRight!) < 2, 'it starts where the menu ends')
  assert.ok(Math.abs(geometry.headRight! - geometry.w!) < 2, 'and runs to the edge')
  assert.ok(geometry.handleLeft! - geometry.headLeft! < 40, 'the handle is its leftmost thing')
  assert.ok(geometry.rightLeft! > geometry.w! / 2, 'and the frame controls are at the other end')
  await page.close()
})

test('the header controls read theme, then Projects, then the project itself', skip, async () => {
  // Left to right: the thing about the page, the list of frames, and the frame
  // you are in. The switcher is last because it is the one everything below is
  // being read inside.
  const page = await open()
  const order = (await page.evaluate(
    `[...document.querySelectorAll('.head-right > *')].map(el => el.id || el.className)`,
  )) as string[]
  assert.deepEqual(order, ['theme', 'tab-projects', 'switcher'])
  await page.close()
})

test('no live chip: a connection you do not have to think about is not worth a pixel', skip, async () => {
  const page = await open()
  assert.equal(await page.evaluate(`!!document.getElementById('live')`), false)
  await page.close()
})

test('the choice is remembered, and applied before the page paints', skip, async () => {
  // Reading it after first paint means every reload flashes the wrong theme,
  // which is the whole reason the head script exists.
  const page = await open()
  await page.evaluate(`document.getElementById('theme').click()`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  assert.equal(
    await page.evaluate(`document.documentElement.dataset.theme`),
    'light',
    'the attribute is set by the head script, before any stylesheet applies',
  )
  await page.waitForFunction(`document.querySelectorAll('.kpi').length > 0`, { timeout: 8000 })
  assert.equal(await page.evaluate(`getComputedStyle(document.body).backgroundColor`), 'rgb(255, 251, 245)')
  // Put it back: pages in this suite share an origin, so a remembered choice is
  // shared state that would quietly decide the theme for every test after this
  // one — which is exactly what it did.
  await page.evaluate(`localStorage.removeItem('atelier:theme')`)
  await page.close()
})

test('no tile inverts into a white slab in the dark theme', skip, async () => {
  // The third KPI tile is a deliberate inverted tile in the light theme. Carried
  // over literally it became a near-white card on a near-black page, which reads
  // as a rendering fault rather than as emphasis.
  const page = await open()
  const tiles = (await page.evaluate(`
    document.documentElement.dataset.theme = 'dark'
    ;[...document.querySelectorAll('.kpi')].map((el) => getComputedStyle(el).backgroundColor)
  `)) as string[]
  for (const bg of tiles) {
    const [r, g, b] = bg.match(/\d+/g)!.map(Number)
    assert.ok(r! + g! + b! < 300, `a tile is ${bg} in the dark theme`)
  }
  await page.close()
})

test('both themes keep readable contrast on the text that carries the status', skip, async () => {
  const luminance = (rgb: string) => {
    const [r, g, b] = rgb.match(/\d+/g)!.map((n) => {
      const c = Number(n) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const page = await open()
  for (const theme of ['dark', 'light']) {
    await page.evaluate(`document.documentElement.dataset.theme = '${theme}'`)
    // An IIFE, because page.evaluate runs each string in the same global scope
    // and a bare `const` on the second pass through this loop is a redeclaration.
    const [fg, bg] = (await page.evaluate(`
      (() => {
        const el = document.getElementById('page-sub')
        return [getComputedStyle(el).color, getComputedStyle(document.body).backgroundColor]
      })()
    `)) as [string, string]
    const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
    const ratio = (a! + 0.05) / (b! + 0.05)
    assert.ok(ratio > 3, `${theme}: the header subtitle is ${ratio.toFixed(1)}:1 against the page`)
  }
  await page.evaluate(`document.documentElement.removeAttribute('data-theme')`)
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

test('success is not drawn in the colour reserved for failure', skip, async () => {
  // The run-success card was rendered in the vermilion tint, so "92% of runs
  // succeeded" was set in the shade that means something is wrong — worse than
  // off-palette, it says the opposite of the number next to it.
  const page = await open()

  const c = (await page.evaluate(`(() => {
    const root = getComputedStyle(document.documentElement)
    const v = n => root.getPropertyValue(n).trim()
    const card = document.querySelector('.kpi.k2')
    const legend = [...document.querySelectorAll('.chart-legend i')].map(
      i => getComputedStyle(i).backgroundColor)
    return {
      ok: v('--ok'), bad: v('--bad'), ink: v('--ink'),
      k2bg: getComputedStyle(card).backgroundColor,
      badSoft: v('--bad-soft'),
      cardLabel: card.innerText,
      legend,
    }
  })()`)) as Record<string, string | string[]>

  assert.match(String(c.cardLabel), /Run success/, 'the k2 card is the run-success card')
  assert.notEqual(c.ok, c.bad, 'success and failure must be distinguishable')
  assert.notEqual(c.ok, c.ink, 'success has a colour of its own, not the body ink')

  // The card must not be tinted with the failure colour.
  const bad = String(c.badSoft).replace(/\s/g, '').toLowerCase()
  assert.notEqual(String(c.k2bg).replace(/\s/g, '').toLowerCase(), bad)

  // And the two chart swatches have to differ, or the chart says nothing.
  const [succeeded, failed] = c.legend as string[]
  assert.notEqual(succeeded, failed, 'succeeded and failed need different swatches')
  await page.close()
})

test('an asset can be deleted from the viewer, and the grid follows', skip, async () => {
  const assets = await import('../src/core/assets.ts')
  const doomed = assets.store(Buffer.from('bytes-for-the-delete-test-' + Date.now()), {
    mime: 'image/png',
    prompt: 'about to be deleted',
  })
  repo.setAssetDescription(doomed.id, 'ZZZ delete me')

  const page = await open()
  // The dashboard asks in its own dialog now. The browser's blocks the event
  // loop the live stream runs on, cannot be styled, and reads as though the
  // page is asking at the moment the question is about the button just pressed.
  page.on('dialog', () => assert.fail('the dashboard must not raise a browser dialog'))

  await page.evaluate(`location.hash = '#assets'`)
  await page.waitForFunction(`document.querySelectorAll('#assets [data-asset]').length > 0`, { timeout: 8000 })

  const before = (await page.evaluate(`document.querySelectorAll('#assets [data-asset]').length`)) as number

  // Newest first, so the one just stored is at index 0.
  await page.evaluate(`document.querySelectorAll('#assets [data-asset]')[0].click()`)
  await page.waitForFunction(`document.querySelector('#viewer').open`, { timeout: 4000 })
  await page.click('#v-delete')
  // The viewer is a modal dialog, so everything outside it is inert. A confirm
  // drawn as an ordinary overlay rendered fine and swallowed every click aimed
  // at it, which is why this one is a dialog too.
  await page.waitForSelector('#ask[open]', { timeout: 4000 })
  await page.click('#ask-go')
  await new Promise((r) => setTimeout(r, 900))

  assert.equal(repo.getAsset(doomed.id), null, 'the asset is gone from the database')
  assert.equal(await page.evaluate(`document.querySelector('#viewer').open`), false, 'the viewer closes')
  const after = (await page.evaluate(`document.querySelectorAll('#assets [data-asset]').length`)) as number
  assert.equal(after, before - 1, 'and the grid refreshes without it')
  await page.close()
})

test('deleting cannot be triggered without confirming', skip, async () => {
  const assets = await import('../src/core/assets.ts')
  const spared = assets.store(Buffer.from('bytes-that-should-survive-' + Date.now()), {
    mime: 'image/png',
    prompt: 'should survive',
  })

  const page = await open()

  await page.evaluate(`location.hash = '#assets'`)
  await page.waitForFunction(`document.querySelectorAll('#assets [data-asset]').length > 0`, { timeout: 8000 })
  await page.evaluate(`document.querySelectorAll('#assets [data-asset]')[0].click()`)
  await page.waitForFunction(`document.querySelector('#viewer').open`, { timeout: 4000 })
  await page.click('#v-delete')
  await page.waitForSelector('#ask[open]', { timeout: 4000 })
  await page.click('#ask-stop')
  await new Promise((r) => setTimeout(r, 700))

  assert.ok(repo.getAsset(spared.id), 'declining the prompt must leave the asset alone')
  await page.close()
})

test('an asset is addressed by id, so a reordering grid cannot delete the wrong one', skip, async () => {
  // The grid was keyed on array position. It is rebuilt on every state frame,
  // so an index captured at render time can point somewhere else by the time it
  // is clicked — survivable when the only thing a click did was open a viewer,
  // not once one of the buttons deletes.
  const assets = await import('../src/core/assets.ts')
  const keep = assets.store(Buffer.from('must-survive-' + Date.now()), { mime: 'image/png' })
  repo.setAssetDescription(keep.id, 'the one that must survive')

  const page = await open()
  await page.evaluate(`location.hash = '#assets'`)
  await page.waitForFunction(`document.querySelectorAll('#assets [data-asset]').length > 0`, { timeout: 8000 })

  // Every handle is an id, not a number.
  const handles = (await page.evaluate(
    `[...document.querySelectorAll('#assets [data-asset]')].map(e => e.dataset.asset)`,
  )) as string[]
  assert.ok(handles.length > 0)
  for (const h of handles) {
    assert.match(h, /^[0-9a-f-]{36}$/, `expected an asset id, got ${JSON.stringify(h)}`)
  }

  // Opening by id gets that asset, whatever the grid has done since.
  await page.evaluate(`document.querySelector('[data-asset="${keep.id}"]').click()`)
  await page.waitForFunction(`document.querySelector('#viewer').open`, { timeout: 4000 })
  const shown = await page.evaluate(`document.querySelector('#v-desc').value`)
  assert.equal(shown, 'the one that must survive')
  await page.close()
})

/* ------------------------------------------------------------ projects */

test('the switcher names the project everything below is being read inside', skip, async () => {
  const other = repo.createProject('Second Project')
  const page = await open()

  const shown = await page.evaluate(`document.querySelector('#proj-name').textContent`)
  assert.equal(shown, repo.activeProject().name)

  // The menu offers every project, marking where you are.
  await page.click('#proj-btn')
  await new Promise((r) => setTimeout(r, 150))
  const options = (await page.evaluate(
    `[...document.querySelectorAll('#proj-menu [data-switch]')].map(b => b.dataset.switch)`,
  )) as string[]
  assert.ok(options.includes(other.id), 'every project is switchable to')
  assert.ok(options.includes(repo.activeProject().id))
  await page.close()
})

test('switching changes what the whole page is showing', skip, async () => {
  const a = repo.createProject('Switch Source')
  const b = repo.createProject('Switch Target')

  repo.setActiveProject(a.id)
  repo.saveWorkflow({
    name: 'only-in-source',
    description: 'test',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    steps: [{ id: 's', kind: 'click', selectors: [{ strategy: 'id', value: '#a', score: 92 }], timeoutMs: 1000 }],
  } as never)

  const page = await open()
  await page.evaluate(`location.hash = '#workflows'`)
  await page.waitForFunction(`document.querySelector('#workflows').innerText.includes('only-in-source')`, { timeout: 8000 })

  await page.evaluate(`document.querySelector('[data-switch="${b.id}"]').click()`)
  await page.waitForFunction(
    `!document.querySelector('#workflows').innerText.includes('only-in-source')`,
    { timeout: 8000 },
  )
  assert.equal(repo.activeProject().id, b.id, 'and the daemon agrees')
  await page.close()
})

test('a project holding work offers no delete button at all', skip, async () => {
  // A control that always refuses teaches people to ignore controls.
  const full = repo.createProject('Holds Work')
  repo.setActiveProject(full.id)
  repo.saveWorkflow({
    name: 'makes-it-non-empty',
    description: 'test',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    steps: [{ id: 's', kind: 'click', selectors: [{ strategy: 'id', value: '#a', score: 92 }], timeoutMs: 1000 }],
  } as never)
  const empty = repo.createProject('Holds Nothing')
  repo.setActiveProject(empty.id)

  const page = await open()
  await page.evaluate(`location.hash = '#projects'`)
  await page.waitForFunction(`document.querySelectorAll('#projects .wf').length > 0`, { timeout: 8000 })

  assert.equal(
    await page.evaluate(`!!document.querySelector('[data-delproj="${full.id}"]')`),
    false,
    'the one holding work cannot be deleted, so it is not offered',
  )
  // Nor the one you are standing in.
  assert.equal(await page.evaluate(`!!document.querySelector('[data-delproj="${empty.id}"]')`), false)
  await page.close()
})

test('a project can be created from the page', skip, async () => {
  const page = await open()
  await page.evaluate(`location.hash = '#projects'`)
  await page.waitForFunction(`document.querySelector('#proj-form')`, { timeout: 8000 })

  const name = 'Made From The Page ' + Date.now()
  await page.type('#proj-input', name)
  await page.click('#proj-form button[type=submit]')
  await new Promise((r) => setTimeout(r, 900))

  assert.ok(repo.listProjects().some((p) => p.name === name), 'it exists')
  assert.notEqual(repo.activeProject().name, name, 'and creating did not silently move you into it')
  await page.close()
})

/* -------------------------------------------------------------- connect */

test('the Connect tab shows a config an agent can actually be pointed at', skip, async () => {
  const page = await open()
  await page.evaluate(`document.querySelector('[data-tab="connect"]').click()`)
  await page.waitForFunction(`document.getElementById('mcp-json').textContent.includes('mcpServers')`, {
    timeout: 8000,
  })
  const shown = JSON.parse(await page.evaluate(`document.getElementById('mcp-json').textContent`))
  assert.equal(shown.mcpServers.atelier.type, 'http')
  assert.match(shown.mcpServers.atelier.url, new RegExp(`127\\.0\\.0\\.1:${PORT}/mcp$`))
  assert.match(shown.mcpServers.atelier.headers.Authorization, /^Bearer \S+/)
  await page.close()
})

test('the Connect tab hands out the token of the project on screen', skip, async () => {
  // One daemon, one config file per project. The token is how an agent knows
  // where it is working, so the file you download while looking at a project is
  // the file that puts an agent in that project.
  const here = repo.activeProject()
  const page = await open()
  await page.evaluate(`document.querySelector('[data-tab="connect"]').click()`)
  await page.waitForFunction(`document.getElementById('mcp-json').textContent.includes('mcpServers')`, {
    timeout: 8000,
  })
  const shown = JSON.parse(await page.evaluate(`document.getElementById('mcp-json').textContent`))
  assert.equal(shown.mcpServers.atelier.headers.Authorization, `Bearer ${here.token}`)
  assert.match(
    await page.evaluate(`document.getElementById('mcp-download').getAttribute('href')`),
    new RegExp(`project=${here.id}`),
  )
  await page.close()
})

test('issuing a new token retires the old one, and asks before it does', skip, async () => {
  const before = repo.activeProject().token
  const page = await open()
  await page.evaluate(`document.querySelector('[data-tab="connect"]').click()`)
  await page.waitForFunction(`document.getElementById('mcp-json').textContent.includes('mcpServers')`, {
    timeout: 8000,
  })
  await page.click('#mcp-rotate')
  await page.waitForSelector('#ask[open]', { timeout: 4000 })
  await page.click('#ask-go')
  await page.waitForFunction(
    `!document.getElementById('mcp-json').textContent.includes(${JSON.stringify(before)})`,
    { timeout: 8000 },
  )
  assert.notEqual(repo.activeProject().token, before)
  assert.equal(repo.projectByToken(before), null, 'the old one opens nothing')
  await page.close()
})

/* --------------------------------------------------------- one workflow */

test('a workflow has a page of its own, reachable by name from anywhere', skip, async () => {
  const project = repo.createProject('Workflow Page')
  repo.setActiveProject(project.id)
  repo.saveWorkflow({
    name: 'has-a-page',
    description: '',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [{ name: 'prompt', description: 'x', required: true }],
    produces: 'image',
    steps: [
      {
        id: 'w1',
        kind: 'type',
        target: 'Describe the image',
        valueMode: 'dynamic',
        inputName: 'prompt',
        sampleValue: 'a rope bridge',
        value: '{{prompt}}',
        timeoutMs: 30000,
        note: 'Type the prompt into Describe the image',
        selectors: [{ strategy: 'id', value: '#p', score: 92 }],
      },
      {
        id: 'w2',
        kind: 'click',
        target: 'Generate',
        timeoutMs: 30000,
        note: 'Click Generate',
        selectors: [{ strategy: 'text', value: 'Generate', score: 96 }],
      },
    ],
  } as never)

  const page = await open()
  // The address the extension popup links to.
  await page.evaluate(`location.hash = '#workflow/has-a-page'`)
  await page.waitForFunction(`document.querySelectorAll('#workflow-one .steps li').length === 2`, {
    timeout: 8000,
  })

  const rows = (await page.evaluate(
    `[...document.querySelectorAll('#workflow-one .steps li')].map(li =>
      [...li.querySelectorAll('.step-row')].map(r => r.querySelector('.step-v').textContent))`,
  )) as string[][]
  // Read top to bottom here, unlike the recorder's panel: this is the order
  // replay runs them in, and a page you arrive at cold should read forwards.
  assert.deepEqual(rows, [
    ['Describe the image', 'Type text into it'],
    ['Generate', 'Click it'],
  ])

  // What the agent has to pass, which is the question anyone opening this page
  // to call the thing actually has.
  const text = (await page.evaluate(`document.querySelector('#workflow-one').innerText`)) as string
  assert.match(text, /\{\{prompt\}\}/)
  assert.match(text, /a rope bridge/, 'and what a test run would type')
  await page.close()
})

test('a value can be changed from the page; an action cannot', skip, async () => {
  const page = await open()
  await page.evaluate(`location.hash = '#workflow/has-a-page'`)
  await page.waitForFunction(`document.querySelectorAll('#workflow-one .steps li').length === 2`, {
    timeout: 8000,
  })

  // Nothing anywhere offers to change what a step does.
  assert.equal(
    await page.evaluate(`document.querySelectorAll('#workflow-one [data-action], #workflow-one select').length`),
    0,
  )

  await page.click('#workflow-one [data-edit="w1"]')
  await page.waitForSelector('#workflow-one .step-edit', { timeout: 4000 })
  await page.click('#workflow-one [data-mode="static"]')
  await page.waitForFunction(
    `document.querySelector('#workflow-one [data-mode="static"]').getAttribute('aria-pressed') === 'true'`,
    { timeout: 4000 },
  )
  await page.evaluate(`document.getElementById('sv').value = 'a fixed prompt'`)
  await page.click('#workflow-one [data-save-step]')
  await new Promise((r) => setTimeout(r, 900))

  const saved = repo.getWorkflowByName('has-a-page')!
  const step = saved.steps.find((x) => x.id === 'w1')!
  assert.equal(step.valueMode, 'static')
  assert.equal(step.value, 'a fixed prompt')
  // A static value is setup, so it stops being part of the signature the agent
  // sees — which is the whole reason to mark one.
  assert.deepEqual(saved.inputs, [])
  await page.close()
})

test('a clashing input name is refused, and the page says so', skip, async () => {
  // The rule lives in the repo, so both write paths get it — but a rule nobody
  // is told about presents as a Save button that does nothing.
  const project = repo.activeProject()
  repo.saveWorkflow({
    projectId: project.id,
    name: 'two-fields',
    description: 'test',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    steps: [
      {
        id: 'f1',
        kind: 'type',
        target: 'Same text',
        valueMode: 'dynamic',
        inputName: 'same_text',
        sampleValue: 'a',
        value: '{{same_text}}',
        timeoutMs: 30000,
        selectors: [{ strategy: 'id', value: '#a', score: 92 }],
      },
      {
        id: 'f2',
        kind: 'type',
        target: 'Other',
        valueMode: 'static',
        sampleValue: 'b',
        value: 'b',
        timeoutMs: 30000,
        selectors: [{ strategy: 'id', value: '#b', score: 92 }],
      },
    ],
  } as never)

  const page = await open()
  await page.evaluate(`location.hash = '#workflow/two-fields'`)
  await page.waitForSelector('#workflow-one [data-edit="f2"]', { timeout: 8000 })
  await page.click('#workflow-one [data-edit="f2"]')
  await page.waitForSelector('#workflow-one [data-mode="dynamic"]', { timeout: 4000 })
  await page.click('#workflow-one [data-mode="dynamic"]')
  await page.waitForSelector('#iv', { timeout: 4000 })
  // A different spelling of a name that is already taken.
  await page.evaluate(`document.getElementById('iv').value = 'SAME Text'`)
  await page.click('#workflow-one [data-save-step]')

  await page.waitForSelector('#ask[open]', { timeout: 4000 })
  const said = await page.evaluate(`document.querySelector('#ask-card p').textContent`)
  assert.match(said as string, /already asks the agent for/i)

  assert.equal(repo.getWorkflowByName('two-fields')!.steps[1]!.valueMode, 'static', 'unchanged')
  await page.close()
})

test('an undescribed workflow says so, and can be described from its page', skip, async () => {
  // The fallback is composed at render time rather than stored, so "nobody has
  // explained this" stays a fact the page can report. A generated sentence in
  // the same voice as a written one is how a library ends up looking
  // documented when nothing has been documented.
  repo.saveWorkflow({
    projectId: repo.activeProject().id,
    name: 'needs-describing',
    description: '',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'image',
    steps: [
      {
        id: 'n1',
        kind: 'click',
        target: 'Generate',
        timeoutMs: 30000,
        note: 'Click Generate',
        selectors: [{ strategy: 'id', value: '#g', score: 92 }],
      },
    ],
  } as never)

  const page = await open()
  await page.evaluate(`location.hash = '#workflow/needs-describing'`)
  await page.waitForSelector('#workflow-one [data-edit-desc]', { timeout: 8000 })

  const before = (await page.evaluate(
    `document.querySelector('#workflow-one .wf-desc').textContent`,
  )) as string
  assert.match(before, /nobody has said what this is for/i)

  await page.click('#workflow-one [data-edit-desc]')
  await page.waitForSelector('#wf-desc', { timeout: 4000 })
  await page.evaluate(
    `document.getElementById('wf-desc').value = 'Generates one illustration from a full prompt'`,
  )
  await page.click('#workflow-one [data-save-desc]')
  // Null-safe: the page redraws twice around this write — once from the state
  // frame the write itself causes, once to close the editor — and a predicate
  // that dereferences the element fails on whichever poll lands between them.
  await page.waitForFunction(
    `(document.querySelector('#workflow-one .wf-desc')?.textContent || '').includes('one illustration')`,
    { timeout: 8000 },
  )
  assert.equal(
    repo.getWorkflowByName('needs-describing')!.description,
    'Generates one illustration from a full prompt',
  )
  await page.close()
})

test('the listing says which workflows nobody has explained', skip, async () => {
  const page = await open()
  await page.evaluate(`location.hash = '#workflows'`)
  await page.waitForFunction(
    `document.querySelector('#workflows').innerText.includes('needs-describing')`,
    { timeout: 8000 },
  )
  // Described by the test above, so this one is about the *other* fixture —
  // the point being that an absent description reads as absent rather than as
  // a sentence somebody wrote.
  const undescribed = await page.evaluate(
    `[...document.querySelectorAll('#workflows .wf')].some(el =>
       el.querySelector('.wf-desc.none') && el.innerText.includes('not described yet'))`,
  )
  assert.equal(undescribed, true)
  await page.close()
})

test('a workflow can be turned off without being lost, and back on', skip, async () => {
  const page = await open()
  await page.evaluate(`location.hash = '#workflow/has-a-page'`)
  await page.waitForSelector('#workflow-one [data-status="disabled"]', { timeout: 8000 })
  await page.click('#workflow-one [data-status="disabled"]')
  await page.waitForFunction(`!!document.querySelector('#workflow-one [data-status="active"]')`, {
    timeout: 8000,
  })

  const off = repo.getWorkflowByName('has-a-page')!
  assert.equal(off.status, 'disabled')
  assert.equal(off.steps.length, 2, 'it keeps everything it had')

  await page.click('#workflow-one [data-status="active"]')
  await page.waitForFunction(`!!document.querySelector('#workflow-one [data-status="disabled"]')`, {
    timeout: 8000,
  })
  assert.equal(repo.getWorkflowByName('has-a-page')!.status, 'active')
  await page.close()
})

test('deleting a workflow asks first, and says what disabling would do instead', skip, async () => {
  const page = await open()
  await page.evaluate(`location.hash = '#workflow/has-a-page'`)
  await page.waitForSelector('#workflow-one [data-delete]', { timeout: 8000 })
  await page.click('#workflow-one [data-delete]')
  await page.waitForSelector('#ask[open]', { timeout: 4000 })
  const body = (await page.evaluate(`document.querySelector('#ask-card p').textContent`)) as string
  assert.match(body, /disable it instead/i)
  await page.click('#ask-stop')
  assert.ok(repo.getWorkflowByName('has-a-page'), 'declining leaves it alone')
  await page.close()
})

test('the token is not in the page source, only in what Connect fetches', skip, async () => {
  // A dashboard left open in a tab should not have the credential sitting in
  // its HTML, where anything that can read the document can read it.
  const page = await open()
  const html = await page.evaluate(`document.documentElement.outerHTML`)
  assert.equal(String(html).includes('Bearer '), false)
  await page.close()
})

test('Download hands over a file rather than navigating the dashboard away', skip, async () => {
  const page = await open()
  await page.evaluate(`document.querySelector('[data-tab="connect"]').click()`)
  const attr = await page.evaluate(
    `document.getElementById('mcp-download').getAttribute('download')`,
  )
  assert.equal(attr, '.mcp.json')
  await page.close()
})

/* ------------------------------------------------- assets that are not images */

/**
 * An asset is whatever a workflow captured, and that was never only pictures.
 *
 * The grid drew an `<img>` for `image/*` and a blank square for everything
 * else, and the viewer held one `<img>` full stop — so an audio clip, a video,
 * a PDF and a captured block of text all opened as a broken picture. The mime
 * has travelled with every asset since the beginning; nothing new had to be
 * stored to tell them apart.
 */

/** A tiny but genuine file of each kind, so nothing renders from a lie. */
async function seedKinds() {
  const assets = await import('../src/core/assets.ts')
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000040000000408060000' + '00'.repeat(20),
    'hex',
  )
  const made: Record<string, string> = {}
  const kinds: Array<[string, string, Buffer]> = [
    ['image', 'image/png', png],
    ['audio', 'audio/mpeg', Buffer.from('ID3' + 'x'.repeat(40))],
    ['video', 'video/webm', Buffer.from('\u001aEß£' + 'x'.repeat(40))],
    ['pdf', 'application/pdf', Buffer.from('%PDF-1.4\n' + 'x'.repeat(40))],
    ['text', 'text/plain', Buffer.from('the captured answer, in full')],
    ['other', 'application/zip', Buffer.from('PK\u0003\u0004' + 'x'.repeat(40))],
  ]
  for (const [name, mime, bytes] of kinds) {
    made[name] = assets.store(bytes, { mime, prompt: 'seed ' + name }).id
  }
  return made
}

test('every kind of asset is drawn as the thing it is, not as a blank square', skip, async () => {
  const project = repo.createProject('Assets By Kind')
  repo.setActiveProject(project.id)
  const made = await seedKinds()

  const page = await open()
  await page.evaluate(`location.hash = '#assets'`)
  await page.waitForFunction(`document.querySelectorAll('#assets .tile').length >= 6`, { timeout: 8000 })

  // Scoped to the grid on purpose: the overview's strip of recent assets
  // carries data-asset as well and comes first in the document, so an unscoped
  // selector reads the wrong element and reports on a thumbnail that is not
  // the one under test.
  const shape = async (id: string) =>
    page.evaluate(`(() => {
      const tile = document.querySelector('#assets [data-asset="${id}"]')
      const thumb = tile.querySelector('.thumb')
      return { tag: thumb.tagName.toLowerCase(), label: thumb.textContent.trim() }
    })()`)

  assert.equal(((await shape(made.image!)) as any).tag, 'img')
  // A video really can show itself; the rest say what they are in words.
  assert.equal(((await shape(made.video!)) as any).tag, 'video')
  assert.deepEqual(await shape(made.audio!), { tag: 'span', label: 'mpeg' })
  assert.deepEqual(await shape(made.pdf!), { tag: 'span', label: 'pdf' })
  assert.deepEqual(await shape(made.text!), { tag: 'span', label: 'plain' })
  assert.deepEqual(await shape(made.other!), { tag: 'span', label: 'zip' })
  await page.close()
})

test('opening one gives you something that can actually play or render it', skip, async () => {
  const made = await seedKinds()
  const page = await open()
  await page.evaluate(`location.hash = '#assets'`)
  await page.waitForFunction(`document.querySelectorAll('#assets .tile').length > 0`, { timeout: 8000 })

  const stageOf = async (id: string) => {
    await page.evaluate(`document.querySelector('#assets [data-asset="${id}"]').click()`)
    await page.waitForFunction(`document.querySelector('#viewer').open`, { timeout: 4000 })
    const tag = await page.evaluate(
      `document.querySelector('#v-stage img, #v-stage video, #v-stage audio, #v-stage iframe, #v-stage pre')?.tagName.toLowerCase()`,
    )

    await page.evaluate(`document.querySelector('#viewer').close()`)
    return tag
  }

  assert.equal(await stageOf(made.image!), 'img')
  assert.equal(await stageOf(made.audio!), 'audio')
  assert.equal(await stageOf(made.video!), 'video')
  assert.equal(await stageOf(made.pdf!), 'iframe')
  assert.equal(await stageOf(made.text!), 'pre')
  await page.close()
})

test('a captured block of text is read, not framed', skip, async () => {
  const made = await seedKinds()
  const page = await open()
  await page.evaluate(`location.hash = '#assets'`)
  await page.waitForFunction(`document.querySelectorAll('#assets .tile').length > 0`, { timeout: 8000 })
  await page.evaluate(`document.querySelector('#assets [data-asset="${made.text}"]').click()`)
  await page.waitForFunction(
    `(document.querySelector('#v-text')?.textContent || '').includes('captured answer')`,
    { timeout: 6000 },
  )
  await page.evaluate(`document.querySelector('#viewer').close()`)
  await page.close()
})

/* ------------------------------------------------------------ bulk delete */

test('nothing selected means no toolbar at all', skip, async () => {
  // A bar that is always there, mostly disabled, is a bar people stop reading.
  const page = await open()
  await page.evaluate(`location.hash = '#assets'`)
  await page.waitForFunction(`document.querySelectorAll('#assets .tile').length > 0`, { timeout: 8000 })
  assert.equal(await page.evaluate(`document.getElementById('bulk').hidden`), true)
  await page.close()
})

test('a selection can be deleted in one decision', skip, async () => {
  const project = repo.createProject('Bulk Delete')
  repo.setActiveProject(project.id)
  const made = await seedKinds()
  const doomed = [made.audio!, made.pdf!, made.other!]

  const page = await open()
  await page.evaluate(`location.hash = '#assets'`)
  await page.waitForFunction(`document.querySelectorAll('#assets .tile').length >= 6`, { timeout: 8000 })

  for (const id of doomed) await page.click(`[data-pick="${id}"]`)
  await page.waitForFunction(`!document.getElementById('bulk').hidden`, { timeout: 4000 })
  assert.equal(await page.evaluate(`document.getElementById('bulk-count').textContent`), '3 selected')

  await page.click('#bulk-delete')
  await page.waitForSelector('#ask[open]', { timeout: 4000 })
  await page.click('#ask-go')
  await page.waitForFunction(`document.querySelectorAll('#assets .tile').length === 3`, { timeout: 8000 })

  for (const id of doomed) assert.equal(repo.getAsset(id), null, 'gone from the database')
  assert.ok(repo.getAsset(made.image!), 'and nothing else went with them')
  assert.equal(await page.evaluate(`document.getElementById('bulk').hidden`), true, 'the bar stands down')
  await page.close()
})

test('deleting a selection asks first, and declining keeps every one', skip, async () => {
  const made = await seedKinds()
  const page = await open()
  await page.evaluate(`location.hash = '#assets'`)
  await page.waitForFunction(`document.querySelectorAll('#assets .tile').length > 0`, { timeout: 8000 })
  await page.click(`[data-pick="${made.text}"]`)
  await page.click('#bulk-delete')
  await page.waitForSelector('#ask[open]', { timeout: 4000 })
  await page.click('#ask-stop')
  await new Promise((r) => setTimeout(r, 500))
  assert.ok(repo.getAsset(made.text!), 'declining leaves it alone')
  await page.close()
})

test('a selection cannot outlive what is in it', skip, async () => {
  // An asset deleted from somewhere else must not stay ticked and come back on
  // the next Delete, taking an id that now belongs to nothing.
  const project = repo.createProject('Stale Selection')
  repo.setActiveProject(project.id)
  const made = await seedKinds()

  const page = await open()
  await page.evaluate(`location.hash = '#assets'`)
  await page.waitForFunction(`document.querySelectorAll('#assets .tile').length >= 6`, { timeout: 8000 })
  await page.click(`[data-pick="${made.pdf}"]`)
  await page.waitForFunction(`document.getElementById('bulk-count').textContent === '1 selected'`)

  // Removed behind the page's back, the way an agent would — through the API,
  // so the daemon announces it. A direct repo call changes the database and
  // tells nobody, which is not how anything else removes an asset.
  await fetch(`http://127.0.0.1:${PORT}/api/assets.delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [made.pdf] }),
  })
  await page.waitForFunction(`document.getElementById('bulk').hidden === true`, { timeout: 8000 })
  await page.close()
})

/* ----------------------------------------- editing a workflow after the fact */

/** A workflow with three steps, one of which should not be there. */
function strayStep(name: string) {
  const step = (id: string, target: string, over: Record<string, unknown> = {}) => ({
    id,
    kind: 'click',
    target,
    timeoutMs: 30000,
    note: 'Click ' + target,
    selectors: [{ strategy: 'id', value: '#' + id, score: 92 }],
    ...over,
  })
  return repo.saveWorkflow({
    projectId: repo.activeProject().id,
    name,
    description: '',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    steps: [
      step('one', 'Prompt', {
        kind: 'type',
        valueMode: 'dynamic',
        inputName: 'prompt',
        sampleValue: 'a rope bridge',
        value: '{{prompt}}',
      }),
      step('stray', 'Somewhere else'),
      step('three', 'Generate'),
    ],
  } as never)
}

test('a step in the middle can be removed from its page', skip, async () => {
  // Not offered while recording, and the difference is the argument: a
  // recording has to keep describing what was actually performed, whereas a
  // saved workflow is an artifact being maintained — and the alternative to
  // dropping one stray click is re-recording the other nineteen.
  const project = repo.createProject('Remove A Step')
  repo.setActiveProject(project.id)
  strayStep('has-a-stray')

  const page = await open()
  await page.evaluate(`location.hash = '#workflow/has-a-stray'`)
  await page.waitForFunction(`document.querySelectorAll('#workflow-one .steps li').length === 3`, {
    timeout: 8000,
  })

  await page.click('#workflow-one [data-drop-step="stray"]')
  await page.waitForSelector('#ask[open]', { timeout: 4000 })
  // It says what it is removing and that it cannot be undone.
  const asked = (await page.evaluate(`document.querySelector('#ask-card p').textContent`)) as string
  assert.match(asked, /Somewhere else/)
  assert.match(asked, /cannot be undone/i)
  await page.click('#ask-go')

  await page.waitForFunction(`document.querySelectorAll('#workflow-one .steps li').length === 2`, {
    timeout: 8000,
  })
  const left = repo.getWorkflowByName('has-a-stray')!
  assert.deepEqual(left.steps.map((s) => s.id), ['one', 'three'])
  await page.close()
})

test('declining leaves the step exactly where it was', skip, async () => {
  strayStep('keep-the-stray')
  const page = await open()
  await page.evaluate(`location.hash = '#workflow/keep-the-stray'`)
  await page.waitForSelector('#workflow-one [data-drop-step="stray"]', { timeout: 8000 })
  await page.click('#workflow-one [data-drop-step="stray"]')
  await page.waitForSelector('#ask[open]', { timeout: 4000 })
  await page.click('#ask-stop')
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(repo.getWorkflowByName('keep-the-stray')!.steps.length, 3)
  await page.close()
})

test('the last step offers no Remove at all', skip, async () => {
  repo.saveWorkflow({
    projectId: repo.activeProject().id,
    name: 'only-one-step',
    description: '',
    status: 'active',
    origins: ['https://x.test'],
    profileId: null,
    inputs: [],
    produces: 'none',
    steps: [
      { id: 'solo', kind: 'click', target: 'Go', timeoutMs: 30000, note: 'Click Go',
        selectors: [{ strategy: 'id', value: '#g', score: 92 }] },
    ],
  } as never)
  const page = await open()
  await page.evaluate(`location.hash = '#workflow/only-one-step'`)
  await page.waitForFunction(`document.querySelectorAll('#workflow-one .steps li').length === 1`, {
    timeout: 8000,
  })
  assert.equal(
    await page.evaluate(`document.querySelectorAll('#workflow-one [data-drop-step]').length`),
    0,
    'a control that always refuses teaches people to ignore controls',
  )
  await page.close()
})

test('the pause between steps is shown in seconds and can be changed', skip, async () => {
  strayStep('has-a-pause')
  const page = await open()
  await page.evaluate(`location.hash = '#workflow/has-a-pause'`)
  await page.waitForSelector('#wf-delay', { timeout: 8000 })
  assert.equal(await page.evaluate(`document.getElementById('wf-delay').value`), '1')

  await page.evaluate(`document.getElementById('wf-delay').value = '2.5'`)
  await page.click('#workflow-one [data-save-delay]')
  await page.waitForFunction(`document.getElementById('wf-delay').value === '2.5'`, { timeout: 8000 })
  assert.equal(repo.getWorkflowByName('has-a-pause')!.stepDelayMs, 2500)
  await page.close()
})

test('a pause below a second is refused by the floor, not by the form', skip, async () => {
  // The input says min=1, but the clamp lives in one place on the server so
  // every road in arrives at the same answer.
  strayStep('pause-floor')
  const page = await open()
  await page.evaluate(`location.hash = '#workflow/pause-floor'`)
  await page.waitForSelector('#wf-delay', { timeout: 8000 })
  assert.equal(await page.evaluate(`document.getElementById('wf-delay').getAttribute('min')`), '1')

  await page.evaluate(`
    fetch('/api/workflows.setStepDelay', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'pause-floor', stepDelayMs: 50 }) })
  `)
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(repo.getWorkflowByName('pause-floor')!.stepDelayMs, 1000)
  await page.close()
})
