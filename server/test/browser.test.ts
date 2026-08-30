/**
 * The recorder and the replay engine, in a real browser.
 *
 * These two files are the ones that could not be tested before, and they are
 * exactly the two where the expensive bugs lived: a recorder that captured
 * every click but not the prompt, and a capture step that could only be
 * recorded by clicking a result that already existed — which is to say, could
 * never record the wait that produced it.
 *
 * The content scripts expect a `chrome.runtime`; a small stub stands in for the
 * service worker and collects what would have been sent to it. Everything else
 * is the real file, running against real DOM.
 *
 * Skipped, rather than failed, when there is no Chrome to drive: this suite has
 * to stay runnable on a machine that has not installed one.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXT = join(HERE, '..', '..', 'extension', 'src', 'content')

const CHROME = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p))

const RECORDER = readFileSync(join(EXT, 'recorder.js'), 'utf-8')
const REPLAY = readFileSync(join(EXT, 'replay.js'), 'utf-8')

/** Stands in for the service worker: collects the actions the recorder emits
 *  and lets the test drive `record.begin` / `record.end`. */
const CHROME_STUB = `
  window.__sent = []
  window.__listeners = []
  window.chrome = {
    runtime: {
      sendMessage: (msg, cb) => { window.__sent.push(msg); cb && cb({ ok: true, count: window.__sent.length }) },
      onMessage: { addListener: (fn) => window.__listeners.push(fn) },
    },
  }
  window.__tell = (msg) => new Promise((r) => {
    let answered = false
    for (const fn of window.__listeners) fn(msg, null, (res) => { if (!answered) { answered = true; r(res) } })
    setTimeout(() => { if (!answered) r(null) }, 50)
  })
  window.__actions = () => window.__sent.filter((m) => m.t === 'record.action').map((m) => m.action)
`

let browser: any = null
let puppeteer: any = null

before(async () => {
  if (!CHROME) return
  puppeteer = (await import('puppeteer-core')).default
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
  })
})

after(async () => {
  await browser?.close()
})

async function pageWith(html: string) {
  const page = await browser.newPage()
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`)
  await page.evaluate(CHROME_STUB)
  await page.evaluate(RECORDER)
  await page.evaluate(`window.__tell({ t: 'record.begin', draftName: 'test', mode: 'workflow', count: 0 })`)
  return page
}

const skip = { skip: CHROME ? false : 'no Chrome on this machine' }

/* ---------------------------------------------------------- the recorder */

test('a click is recorded with every selector candidate the element offers', skip, async () => {
  const page = await pageWith(
    `<button id="go" data-testid="generate" aria-label="Generate">Generate</button>`,
  )
  await page.click('#go')
  const actions = await page.evaluate('window.__actions()')

  const click = actions.find((a: any) => a.kind === 'click')
  assert.ok(click, 'the click should have been recorded')
  const strategies = click.element.selectors.map((s: any) => s.strategy)
  // The fallback list is the whole resilience story. One selector is not a
  // recording, it is a guess.
  assert.ok(strategies.includes('testid'))
  assert.ok(strategies.includes('id'))
  assert.ok(strategies.includes('aria'))
  assert.ok(strategies.includes('xpath'))
  await page.close()
})

test('typing into a contenteditable is recorded — the bug that lost the only step that mattered', skip, async () => {
  const page = await pageWith(`<div id="editor" contenteditable="true"></div>`)
  await page.click('#editor')
  await page.type('#editor', 'the prompt text')
  // The recorder debounces at 600ms so one field is one step, not one keystroke.
  await new Promise((r) => setTimeout(r, 900))

  const actions = (await page.evaluate('window.__actions()')) as any[]
  const typed = actions.find((a) => a.kind === 'type')
  assert.ok(typed, 'typing into a contenteditable must be recorded')
  assert.equal(typed.value, 'the prompt text')
  assert.equal(typed.contentEditable, true)
  await page.close()
})

test('a password is recorded as a step, but its value never is', skip, async () => {
  const page = await pageWith(`<input id="pw" type="password" />`)
  await page.click('#pw')
  await page.type('#pw', 'hunter2')
  await new Promise((r) => setTimeout(r, 900))

  const actions = (await page.evaluate('window.__actions()')) as any[]
  const typed = actions.find((a) => a.kind === 'type')
  assert.ok(typed)
  assert.equal(typed.secret, true)
  assert.equal(typed.value, null)
  assert.equal(JSON.stringify(actions).includes('hunter2'), false)
  await page.close()
})

test('a result can be captured before it exists — the recorder waits for it', skip, async () => {
  // This is the finding the whole rewrite is for. At the moment you click
  // Generate there is nothing to point at, so a recorder that captures by
  // clicking a finished image can never record the wait that produced it.
  const page = await pageWith(`
    <button id="go">Generate</button>
    <div id="output" style="width:400px;height:300px"></div>
  `)

  // Arm capture, then point at the empty region.
  await page.evaluate(`document.querySelector('#atelier-bar [data-act="capture"]').click()`)
  await page.click('#output')

  let actions = (await page.evaluate('window.__actions()')) as any[]
  assert.equal(
    actions.filter((a) => a.kind === 'capture').length,
    0,
    'nothing has appeared yet, so there is nothing to capture',
  )

  // The result turns up later, the way a generated one does.
  await page.evaluate(`
    const img = document.createElement('img')
    img.id = 'result'
    // A real 128px PNG. A malformed one decodes to naturalWidth 0, which the
    // recorder correctly refuses — so the fixture has to be a genuine image.
    img.src = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABMElEQVR4nO3RMQ0AIADAMMC/MG5uxCCjB6uCJZv73BFn6YDfNQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA3AGoA1AGsA1gCsAVgDsAZgDcAagDUAawDWAKwBWAOwBmANwBqANQBrANYArAFYA7AGYA/X5gN2K9J4RQAAAABJRU5ErkJggg=='
    document.querySelector('#output').appendChild(img)
  `)
  await page.waitForFunction(`window.__actions().some((a) => a.kind === 'capture')`, { timeout: 4000 })

  actions = (await page.evaluate('window.__actions()')) as any[]
  const capture = actions.find((a) => a.kind === 'capture')
  assert.ok(capture, 'the observer should have resolved the result once it appeared')
  assert.equal(capture.resolvedByObserver, true)
  assert.equal(capture.capture.as, 'image')
  // And it resolved against the image itself, not the container it was aimed at.
  assert.equal(capture.element.tag, 'img')
  await page.close()
})

test('a spinner in the target region is not mistaken for the result', skip, async () => {
  const page = await pageWith(`<div id="output" style="width:400px;height:300px"></div>`)
  await page.evaluate(`document.querySelector('#atelier-bar [data-act="capture"]').click()`)
  await page.click('#output')

  await page.evaluate(`
    const spinner = document.createElement('img')
    spinner.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
    document.querySelector('#output').appendChild(spinner)
  `)
  await new Promise((r) => setTimeout(r, 500))

  const actions = (await page.evaluate('window.__actions()')) as any[]
  assert.equal(
    actions.filter((a) => a.kind === 'capture').length,
    0,
    'capturing the loading indicator and calling the job done is the failure this guards',
  )
  await page.close()
})

test('a result that is already on screen is captured immediately, not waited for', skip, async () => {
  const page = await pageWith(`
    <div id="output"><pre>a block of already-rendered text long enough to count as a result</pre></div>
  `)
  await page.evaluate(`document.querySelector('#atelier-bar [data-act="capture"]').click()`)
  await page.click('#output')
  await page.waitForFunction(`window.__actions().some((a) => a.kind === 'capture')`, { timeout: 3000 })

  const actions = (await page.evaluate('window.__actions()')) as any[]
  const capture = actions.find((a) => a.kind === 'capture')
  assert.equal(capture.capture.as, 'text', 'the kind is inferred from what turned up')
  assert.equal(capture.resolvedByObserver, false)
  await page.close()
})

test('the wait gesture records a condition rather than a click', skip, async () => {
  const page = await pageWith(`<div id="spinner">Loading…</div>`)
  await page.evaluate(`document.querySelector('#atelier-bar [data-act="wait"]').click()`)
  await page.click('#spinner')

  const actions = (await page.evaluate('window.__actions()')) as any[]
  const wait = actions.find((a) => a.kind === 'wait')
  assert.ok(wait, 'pointing at something while armed should record a wait')
  assert.equal(wait.wait.kind, 'visible')
  // And it must not also be recorded as a click, or replay would click a
  // spinner on the way past.
  assert.equal(actions.filter((a) => a.kind === 'click').length, 0)
  await page.close()
})

test('the recorder bar does not record itself', skip, async () => {
  const page = await pageWith(`<button id="go">Go</button>`)
  await page.evaluate(`document.querySelector('#atelier-bar [data-act="undo"]').click()`)
  const actions = (await page.evaluate('window.__actions()')) as any[]
  assert.equal(actions.filter((a) => a.kind === 'click').length, 0)
  await page.close()
})

/* ------------------------------------------------------------- replay */

async function replayPage(html: string) {
  const page = await browser.newPage()
  await page.setContent(`<!doctype html><html><body>${html}</body></html>`)
  await page.evaluate(REPLAY)
  return page
}

test('replay reports which selector actually resolved', skip, async () => {
  // The signal that makes decay visible. Without it a step matching on a
  // positional XPath looks exactly like one matching on a test id.
  const page = await replayPage(`<button id="real">Go</button>`)
  const result = await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'click', timeoutMs: 1000,
    selectors: [
      { strategy: 'testid', value: '[data-testid="gone"]', score: 98 },
      { strategy: 'id', value: '#real', score: 92 }
    ],
  })`)
  assert.equal((result as any).ok, true)
  assert.equal((result as any).matched.strategy, 'id', 'the testid no longer exists, so id is what won')
  assert.equal((result as any).matched.score, 92)
  await page.close()
})

test('replay prefers the strongest selector that resolves', skip, async () => {
  const page = await replayPage(`<button id="real" data-testid="go">Go</button>`)
  const result = await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'click', timeoutMs: 1000,
    selectors: [
      { strategy: 'id', value: '#real', score: 92 },
      { strategy: 'testid', value: '[data-testid="go"]', score: 98 }
    ],
  })`)
  assert.equal((result as any).matched.strategy, 'testid')
  await page.close()
})

test('a step whose element is missing parks, and says something a human can act on', skip, async () => {
  const page = await replayPage(`<div></div>`)
  const result = (await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'click', timeoutMs: 300, note: 'Click Generate',
    selectors: [{ strategy: 'id', value: '#nope', score: 92 }],
  })`)) as any
  assert.equal(result.ok, false)
  assert.equal(result.recoverable, true, 'a missing element is something a human can fix, not a dead workflow')
  assert.match(result.reason, /Click Generate/)
  await page.close()
})

test('typing reaches a contenteditable, not just an input', skip, async () => {
  const page = await replayPage(`<div id="editor" contenteditable="true"></div>`)
  await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'type', timeoutMs: 1000, value: 'hello there',
    selectors: [{ strategy: 'id', value: '#editor', score: 92 }],
  })`)
  assert.equal(await page.evaluate(`document.querySelector('#editor').innerText.trim()`), 'hello there')
  await page.close()
})

test('a capture waits for its target and then reads it', skip, async () => {
  const page = await replayPage(`<div id="out"></div>`)
  // The image arrives after the step has already started waiting.
  await page.evaluate(`setTimeout(() => {
    const img = document.createElement('img')
    img.id = 'shot'
    img.src = 'https://example.test/x.png'
    document.querySelector('#out').appendChild(img)
  }, 300)`)

  const result = (await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'capture', timeoutMs: 4000,
    capture: { as: 'image', attribute: 'src' },
    selectors: [{ strategy: 'id', value: '#shot', score: 92 }],
    waitBefore: { kind: 'visible', selectors: [{ strategy: 'id', value: '#shot', score: 92 }] },
  })`)) as any

  assert.equal(result.ok, true)
  assert.equal(result.capture.as, 'image')
  assert.match(result.capture.value, /example\.test\/x\.png/)
  await page.close()
})

test('a capture that never gets its target parks rather than returning nothing', skip, async () => {
  const page = await replayPage(`<div id="out"></div>`)
  const result = (await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'capture', timeoutMs: 400,
    capture: { as: 'image' },
    selectors: [{ strategy: 'id', value: '#never', score: 92 }],
    waitBefore: { kind: 'visible', selectors: [{ strategy: 'id', value: '#never', score: 92 }] },
  })`)) as any
  assert.equal(result.ok, false)
  assert.equal(result.recoverable, true)
  await page.close()
})
