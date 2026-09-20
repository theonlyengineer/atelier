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
      // Real Chrome always has an id; it goes undefined only when the context
      // has been invalidated, which is exactly what the recorder checks for.
      id: 'test-extension-id',
      lastError: undefined,
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

/* ------------------------------------------------ capture beyond images */

test('a download capture resolves the link, rather than hunting for an image', skip, async () => {
  // `as: 'download'` has been in the type and in the recorder since the start,
  // and replay never implemented it — everything that was not text fell into a
  // branch that required an <img>, so a workflow recorded against a download
  // link failed with a message about an image it was never going to find.
  const page = await replayPage(`<a id="dl" download href="https://example.test/take.mp3">Download</a>`)
  const result = (await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'capture', timeoutMs: 1000,
    capture: { as: 'download', attribute: 'href' },
    selectors: [{ strategy: 'id', value: '#dl', score: 92 }],
  })`)) as any
  assert.equal(result.ok, true)
  assert.equal(result.capture.as, 'download')
  assert.match(result.capture.value, /example\.test\/take\.mp3/)
  await page.close()
})

test('a captured wrapper gives up its audio, not only its images', skip, async () => {
  // The recorded target is usually the region that was pointed at, not the
  // element that arrived in it. Resolving only <img> there is what limited
  // capture to pictures.
  const page = await replayPage(`<div id="out"><audio id="clip" src="https://example.test/take.mp3"></audio></div>`)
  const result = (await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'capture', timeoutMs: 1000,
    capture: { as: 'image', attribute: 'src' },
    selectors: [{ strategy: 'id', value: '#out', score: 92 }],
  })`)) as any
  assert.equal(result.ok, true)
  assert.match(result.capture.value, /example\.test\/take\.mp3/)
  await page.close()
})

test('a media element that carries its source in a child <source> still resolves', skip, async () => {
  const page = await replayPage(
    `<div id="out"><video id="clip"><source src="https://example.test/clip.webm" type="video/webm"></video></div>`,
  )
  const result = (await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'capture', timeoutMs: 1000,
    capture: { as: 'image', attribute: 'src' },
    selectors: [{ strategy: 'id', value: '#out', score: 92 }],
  })`)) as any
  assert.equal(result.ok, true)
  assert.match(result.capture.value, /example\.test\/clip\.webm/)
  await page.close()
})

test('an image inside the captured wrapper still wins — the path this replaced', skip, async () => {
  const page = await replayPage(`<figure id="out"><img id="shot" src="https://example.test/x.png"></figure>`)
  const result = (await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'capture', timeoutMs: 1000,
    capture: { as: 'image', attribute: 'src' },
    selectors: [{ strategy: 'id', value: '#out', score: 92 }],
  })`)) as any
  assert.equal(result.ok, true)
  assert.equal(result.capture.as, 'image')
  assert.match(result.capture.value, /example\.test\/x\.png/)
  await page.close()
})

test('a wrapper with nothing in it yet parks, and says so without guessing the kind', skip, async () => {
  const page = await replayPage(`<div id="out"><span>Generating…</span></div>`)
  const result = (await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'capture', timeoutMs: 400,
    capture: { as: 'image', attribute: 'src' },
    selectors: [{ strategy: 'id', value: '#out', score: 92 }],
  })`)) as any
  assert.equal(result.ok, false)
  assert.equal(result.recoverable, true, 'still generating is something waiting fixes, not a dead workflow')
  await page.close()
})

/* ------------------------------------------------------------- the panel */

/**
 * The side panel, in a real browser, with the service worker stubbed.
 *
 * The panel had no coverage at all, which is uncomfortable for the surface
 * where a person makes a decision that changes what a workflow is. `chrome` is
 * a stub that answers `panel.hello` and records what the panel sends back, so
 * these tests are about what is rendered and what is dispatched — not about the
 * worker, which has its own failure modes.
 */
const PANEL_DIR = join(HERE, '..', '..', 'extension', 'src', 'panel')
const PANEL_HTML = readFileSync(join(PANEL_DIR, 'panel.html'), 'utf-8')
  .replace(/<script[^>]*><\/script>/g, '')
  .replace(/<link[^>]*>/g, '')
const PANEL_JS = readFileSync(join(PANEL_DIR, 'panel.js'), 'utf-8')
const PANEL_CSS = readFileSync(join(PANEL_DIR, 'panel.css'), 'utf-8')

async function panelWith(actions: unknown[]) {
  const page = await browser.newPage()
  await page.setContent(`<style>${PANEL_CSS}</style>` + PANEL_HTML)
  await page.evaluate(
    `
    window.__sent = []
    window.chrome = {
      runtime: {
        sendMessage: (msg) => {
          window.__sent.push(msg)
          if (msg.t === 'panel.hello') {
            return Promise.resolve({ recording: { name: 'test', actions: ${JSON.stringify(actions)} } })
          }
          return Promise.resolve({ ok: true })
        },
        onMessage: { addListener: () => {} },
      },
    }
    `,
  )
  await page.evaluate(PANEL_JS)
  await page.waitForFunction(`document.querySelectorAll('#capture-list li').length > 0`, { timeout: 4000 })
  return page
}

const typedAction = (label: string, value: string, extra: Record<string, unknown> = {}) => ({
  kind: 'type',
  element: { tag: 'textarea', label, selectors: [{ strategy: 'id', value: '#' + label, score: 92 }] },
  value,
  ...extra,
})

/* --------------------------------------------------- the service worker */

/**
 * The service worker, with the whole of `chrome` stubbed.
 *
 * It had no coverage, and it is the link in the middle of every panel gesture:
 * the panel sends a message, the worker changes the stored recording, and the
 * proposal pass reads what the worker wrote. Both ends were tested and the
 * middle was not, which is the shape of a bug nobody finds until a recording
 * comes back wrong.
 */
const WORKER_SRC =
  readFileSync(join(HERE, '..', '..', 'extension', 'src', 'protocol.js'), 'utf-8').replace(
    /^export /gm,
    '',
  ) +
  '\n' +
  readFileSync(join(HERE, '..', '..', 'extension', 'src', 'background.js'), 'utf-8').replace(
    /^import .*$/m,
    '',
  )

const WORKER_CHROME = `
  window.__sessionStore = {}
  window.__sent = []
  window.__listeners = []
  const listener = (fn) => ({ addListener: (f) => fn.push(f) })
  window.chrome = {
    runtime: {
      sendMessage: (msg) => { window.__sent.push(msg); return Promise.resolve({ ok: true }) },
      onMessage: { addListener: (fn) => window.__listeners.push(fn) },
      onInstalled: listener([]), onStartup: listener([]),
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    storage: {
      local: { get: async () => ({ profileId: 'p', label: 'test' }), set: async () => {} },
      session: {
        get: async (k) => (k in window.__sessionStore ? { [k]: window.__sessionStore[k] } : {}),
        set: async (bag) => Object.assign(window.__sessionStore, bag),
        remove: async (k) => { delete window.__sessionStore[k] },
      },
    },
    tabs: { query: async () => [], sendMessage: async () => {}, create: async () => {},
            update: async () => {}, onUpdated: listener([]) },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    alarms: { create: () => {}, onAlarm: listener([]) },
    notifications: { create: () => {}, clear: () => {}, onClicked: listener([]) },
    permissions: { contains: async () => true, request: async () => true },
    scripting: { executeScript: async () => {}, insertCSS: async () => {} },
    windows: { getCurrent: async () => ({ id: 1 }) },
  }
  // connect() runs at load and probes for a daemon. There isn't one; failing
  // fast is the correct behaviour and is not what these tests are about.
  window.fetch = () => Promise.reject(new Error('no daemon in this test'))
  window.WebSocket = function () { this.close = () => {} }
  window.__ask = (msg) => new Promise((resolve) => {
    let answered = false
    for (const fn of window.__listeners) fn(msg, null, (res) => { if (!answered) { answered = true; resolve(res) } })
    setTimeout(() => { if (!answered) resolve(null) }, 200)
  })
`

/** A worker with one recording already in session storage. */
async function workerWith(actions: unknown[]) {
  const page = await browser.newPage()
  await page.setContent('<!doctype html><html><body></body></html>')
  await page.evaluate(WORKER_CHROME)
  await page.evaluate(
    `window.__sessionStore['atelier:recording'] = {
      draftName: 'test', tabId: 1, actions: ${JSON.stringify(actions)},
      origins: ['https://x.test'], mode: 'workflow',
    }`,
  )
  await page.evaluate(WORKER_SRC)
  return page
}

const typedFor = (label: string, value: string, extra: Record<string, unknown> = {}) => ({
  kind: 'type',
  element: { tag: 'textarea', label, selectors: [{ strategy: 'id', value: '#' + label, score: 92 }] },
  value,
  ...extra,
})

test('the worker records a role against the step the review named', skip, async () => {
  const page = await workerWith([typedFor('Instructions', 'setup'), typedFor('Prompt', 'varies')])
  const res = (await page.evaluate(
    `window.__ask({ t: 'record.role', index: 1, role: 'input' })`,
  )) as any
  assert.equal(res?.ok, true)
  const stored = (await page.evaluate(
    `window.__sessionStore['atelier:recording'].actions.map((a) => a.role ?? null)`,
  )) as unknown[]
  assert.deepEqual(stored, [null, 'input'], 'only the named field is marked')
  await page.close()
})

test('the mark survives in session storage, not in a module variable', skip, async () => {
  // MV3 kills the worker between gestures; anything held in memory is gone by
  // the time the person presses Save.
  const page = await workerWith([typedFor('Prompt', 'varies')])
  await page.evaluate(`window.__ask({ t: 'record.role', index: 0, role: 'fixed' })`)
  assert.equal(
    await page.evaluate(`window.__sessionStore['atelier:recording'].actions[0].role`),
    'fixed',
  )
  await page.close()
})

test('clearing a role removes the key rather than storing an empty one', skip, async () => {
  const page = await workerWith([typedFor('Prompt', 'varies', { role: 'input' })])
  await page.evaluate(`window.__ask({ t: 'record.role', index: 0, role: null })`)
  assert.equal(
    await page.evaluate(`'role' in window.__sessionStore['atelier:recording'].actions[0]`),
    false,
    'an absent role is what hands the field back to the guess',
  )
  await page.close()
})

test('a password cannot be made an input, because its value was never recorded', skip, async () => {
  const page = await workerWith([typedFor('Password', '', { secret: true })])
  const res = (await page.evaluate(
    `window.__ask({ t: 'record.role', index: 0, role: 'input' })`,
  )) as any
  assert.match(res?.error ?? '', /password/i)
  await page.close()
})

test('a click cannot be made an input — there is no value to vary', skip, async () => {
  const page = await workerWith([{ kind: 'click', element: { tag: 'button', label: 'Run', selectors: [] } }])
  const res = (await page.evaluate(
    `window.__ask({ t: 'record.role', index: 0, role: 'input' })`,
  )) as any
  assert.match(res?.error ?? '', /typed field/i)
  await page.close()
})

test('the worker pushes the updated list back, so every surface shows the truth', skip, async () => {
  const page = await workerWith([typedFor('Prompt', 'varies')])
  await page.evaluate(`window.__ask({ t: 'record.role', index: 0, role: 'input' })`)
  const pushed = (await page.evaluate(
    `window.__sent.filter((m) => m.t === 'panel.recording').pop()`,
  )) as any
  assert.equal(pushed?.recording?.actions?.[0]?.role, 'input')
  await page.close()
})

/* ------------------------------------------------------ the recorder bar */

const OVERLAY_CSS = readFileSync(join(EXT, 'overlay.css'), 'utf-8')

/** A page with the recorder running and its stylesheet applied, at a width a
 *  laptop actually has. */
async function barPage(width = 1000) {
  const page = await browser.newPage()
  await page.setViewport({ width, height: 700 })
  await page.setContent(`<!doctype html><html><head><style>${OVERLAY_CSS}</style></head><body></body></html>`)
  await page.evaluate(CHROME_STUB)
  await page.evaluate(RECORDER)
  await page.evaluate(
    `window.__tell({ t: 'record.begin', draftName: 'audio-generation', mode: 'workflow', count: 0 })`,
  )
  await page.waitForFunction(`document.getElementById('atelier-bar')`, { timeout: 4000 })
  return page
}

/** How many lines each piece of text in the bar is laid out on. */
const lineCounts = (page: any) =>
  page.evaluate(`
    [...document.querySelectorAll('#atelier-bar .atelier-btn, #atelier-bar .atelier-count')].map((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return { text: el.textContent.trim(), lines: range.getClientRects().length }
    })
  `)

test('no label in the recorder bar wraps onto a second line', skip, async () => {
  // `all: unset` on the buttons resets white-space to normal, so a squeezed bar
  // wraps "Capture result" inside its own pill rather than staying one row.
  const page = await barPage()
  for (const { text, lines } of await lineCounts(page)) {
    assert.equal(lines, 1, `"${text}" is laid out on ${lines} lines`)
  }
  await page.close()
})

test('the bar may use the whole width of the window, not half of it', skip, async () => {
  // A fixed element with `left` and no `right` is shrink-to-fit inside what
  // remains to its right — half the viewport. The transform that re-centres it
  // does not give that width back, so the bar was cramped at any window size.
  const page = await barPage()
  const { barWidth, viewport } = (await page.evaluate(`
    ({ barWidth: document.getElementById('atelier-bar').getBoundingClientRect().width,
       viewport: window.innerWidth })
  `)) as any
  assert.ok(
    barWidth > viewport / 2,
    `the bar is ${Math.round(barWidth)}px inside a ${viewport}px window — still capped at half`,
  )
  await page.close()
})

test('the bar keeps a gutter rather than running edge to edge', skip, async () => {
  const page = await barPage(620)
  const gap = (await page.evaluate(
    `window.innerWidth - document.getElementById('atelier-bar').getBoundingClientRect().width`,
  )) as number
  assert.ok(gap >= 20, `only ${Math.round(gap)}px of gutter — the padding is escaping the cap`)
  await page.close()
})

test('the bar stays one row, and centred, on a narrow window', skip, async () => {
  const page = await barPage(760)
  const box = (await page.evaluate(`
    const b = document.getElementById('atelier-bar').getBoundingClientRect()
    ;({ height: b.height, left: b.left, right: window.innerWidth - b.right })
  `)) as any
  assert.ok(box.height < 52, `the bar is ${Math.round(box.height)}px tall, so something wrapped`)
  assert.ok(Math.abs(box.left - box.right) < 2, 'still centred')
  await page.close()
})

test('a long workflow name is what gives way, not the controls', skip, async () => {
  // Truncating the name costs nothing — it is already on screen in the panel.
  // Wrapping a button changes where it is and what it looks like mid-recording.
  const page = await barPage(620)
  // Measured on the element's own box, not on a Range over its contents: with
  // text-overflow the ellipsis is a box of its own, so a Range reports two
  // rects for text that is plainly on one line.
  const name = (await page.evaluate(`
    const el = document.querySelector('#atelier-bar .atelier-name')
    ;({ clipped: el.scrollWidth > el.clientWidth, height: el.getBoundingClientRect().height })
  `)) as any
  assert.equal(name.clipped, true, 'the name should be truncated at this width')
  assert.ok(name.height < 24, `the name is ${Math.round(name.height)}px tall, so it wrapped`)
  for (const { text, lines } of await lineCounts(page)) {
    assert.equal(lines, 1, `"${text}" wrapped instead of the name giving way`)
  }
  await page.close()
})

/** The bar, on a page whose own CSS is hostile to it. */
async function barOnPage(pageCss: string, width = 1000) {
  const page = await browser.newPage()
  await page.setViewport({ width, height: 700 })
  await page.setContent(
    `<!doctype html><html><head><style>${OVERLAY_CSS}</style><style>${pageCss}</style></head><body></body></html>`,
  )
  await page.evaluate(CHROME_STUB)
  await page.evaluate(RECORDER)
  await page.evaluate(
    `window.__tell({ t: 'record.begin', draftName: 'audio-generation', mode: 'workflow', count: 0 })`,
  )
  await page.waitForFunction(`document.getElementById('atelier-bar')`, { timeout: 4000 })
  return page
}

const offCentre = (page: any) =>
  page.evaluate(`
    const b = document.getElementById('atelier-bar').getBoundingClientRect()
    Math.abs(b.left - (window.innerWidth - b.right))
  `)

test('the bar stays centred on a page that resets every margin', skip, async () => {
  // Centring with auto margins puts the bar at the mercy of the page: a reset
  // like this is common, and it would leave the bar pinned to the left edge.
  const page = await barOnPage(`* { margin: 0 !important; }`)
  assert.ok((await offCentre(page)) < 2, 'a margin reset should not move the bar')
  await page.close()
})

test('the bar stays centred on a page that resets positioning offsets', skip, async () => {
  const page = await barOnPage(`* { inset: auto; margin-inline: 0 !important; }`)
  assert.ok((await offCentre(page)) < 2, 'the bar should not depend on the page leaving it alone')
  await page.close()
})

test('the bar still fits its controls when the page squeezes it', skip, async () => {
  const page = await barOnPage(`* { margin: 0 !important; }`, 760)
  for (const { text, lines } of await lineCounts(page)) {
    assert.equal(lines, 1, `"${text}" wrapped on a page with a margin reset`)
  }
  await page.close()
})

test('the popup declares a width, because a popup sizes to its content', skip, async () => {
  // Chrome gives a popup no width of its own: without one this collapses to
  // whatever the narrowest line happens to be, which is how a panel built for a
  // docked side panel looks broken the moment it becomes a dropdown.
  const page = await panelWith([typedAction('Prompt', 'varies')])
  const width = (await page.evaluate(`document.body.getBoundingClientRect().width`)) as number
  // Chrome's ceiling is 800. Well under it is a choice; barely over 300 is the
  // cramped column this started as.
  assert.ok(width >= 560 && width <= 800, `the popup body is ${Math.round(width)}px wide`)
  await page.close()
})

/* ------------------------------------------- an orphaned content script */

/**
 * Reloading the extension at chrome://extensions destroys the context every
 * injected content script belongs to, while the script itself keeps running in
 * the page with its listeners attached. Every `chrome.runtime` call from that
 * point throws "Extension context invalidated" — and the bar is still on screen,
 * so the person keeps clicking it and keeps getting nothing.
 */
async function orphanedBar() {
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 700 })
  await page.setContent(
    `<!doctype html><html><head><style>${OVERLAY_CSS}</style></head><body><button id="x">x</button></body></html>`,
  )
  await page.evaluate(CHROME_STUB)
  await page.evaluate(RECORDER)
  await page.evaluate(
    `window.__tell({ t: 'record.begin', draftName: 'audio-generation', mode: 'workflow', count: 0 })`,
  )
  await page.waitForFunction(`document.getElementById('atelier-bar')`, { timeout: 4000 })
  // Now pull the context out from under it, the way a reload does.
  await page.evaluate(`
    window.__errors = []
    // Both: an invalidated context throws synchronously out of the listener,
    // while a promise-form sendMessage rejects. Watching only for rejections
    // reports a clean run for code that is throwing on every click.
    window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)))
    window.addEventListener('error', (e) => window.__errors.push(String(e.message)))
    window.__sent = []
    window.chrome.runtime.id = undefined
    window.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.') }
  `)
  return page
}

test('an orphaned recorder does not throw on every click', skip, async () => {
  const page = await orphanedBar()
  await page.evaluate(`document.getElementById('x').click()`)
  await page.evaluate(`document.getElementById('x').click()`)
  const errors = (await page.evaluate(`window.__errors`)) as string[]
  assert.deepEqual(errors, [], 'a dead context is an expected state, not an exception per click')
  await page.close()
})

test('an orphaned recorder takes its bar away instead of leaving a dead one', skip, async () => {
  // The bar is the only thing telling the person a recording is in progress. If
  // the recording is gone, leaving it on screen is a lie they act on.
  const page = await orphanedBar()
  await page.evaluate(`document.getElementById('x').click()`)
  await page.waitForFunction(`!document.getElementById('atelier-bar')`, { timeout: 2000 })
  await page.close()
})

test('pressing a control on an orphaned bar does not throw either', skip, async () => {
  const page = await orphanedBar()
  await page.evaluate(`document.querySelector('#atelier-bar [data-act="undo"]').click()`)
  assert.deepEqual(await page.evaluate(`window.__errors`), [])
  await page.close()
})

test('a live recorder still reports every action it hears', skip, async () => {
  // The guard must not swallow the ordinary path: this is the bug the whole
  // recorder exists to avoid.
  const page = await barPage()
  await page.evaluate(`document.body.insertAdjacentHTML('beforeend', '<button id="y">y</button>')`)
  await page.evaluate(`document.getElementById('y').click()`)
  await page.waitForFunction(`window.__actions().some((a) => a.kind === 'click')`, { timeout: 3000 })
  await page.close()
})

/* ------------------------------------------ marking a field from the page */

/**
 * Keeping a value is a decision made while typing it, in the page, with the bar
 * already on screen. Sending the person back to the popup to tick a box for a
 * field they are looking at is a worse version of the same question.
 */
async function recordingPage() {
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 700 })
  await page.setContent(
    // Padded below the bar, which is fixed over the top of the window and would
    // otherwise be what a click at these coordinates actually hits.
    `<!doctype html><html><head><style>${OVERLAY_CSS}</style></head>
     <body style="padding-top:140px">
       <textarea id="sys"></textarea><textarea id="prompt"></textarea>
     </body></html>`,
  )
  await page.evaluate(CHROME_STUB)
  await page.evaluate(RECORDER)
  await page.evaluate(
    `window.__tell({ t: 'record.begin', draftName: 'audio-generation', mode: 'workflow', count: 0 })`,
  )
  await page.waitForFunction(`document.getElementById('atelier-bar')`, { timeout: 4000 })
  return page
}

/** Type into a field the way a person does, so the recorder hears it. */
async function typeInto(page: any, id: string, text: string) {
  await page.click(`#${id}`)
  await page.type(`#${id}`, text)
  await page.evaluate(`document.getElementById('${id}').blur()`)
  await page.waitForFunction(
    `window.__actions().some((a) => a.kind === 'type' && a.element.selectors.some((s) => s.value === '#${id}'))`,
    { timeout: 4000 },
  )
}

/* -------------------------------------------------- the review, in the page */

/**
 * Save opens a review in the page rather than committing silently.
 *
 * The recording was made here, looking at this. Sending someone to the
 * extension dropdown to check what was heard — and to see the value a step will
 * actually type — is asking them to verify the work somewhere other than where
 * they did it.
 */
async function reviewPage() {
  const page = await recordingPage()
  await typeInto(page, 'sys', 'You are a careful assistant.')
  await typeInto(page, 'prompt', 'a harbour at dusk')
  // The worker stub answers record.list with whatever was recorded.
  await page.evaluate(`
    window.chrome.runtime.sendMessage = (msg, cb) => {
      window.__sent.push(msg)
      if (msg.t === 'record.list') {
        cb && cb({ name: 'audio-generation', actions: window.__actions() })
        return
      }
      cb && cb({ ok: true })
    }
  `)
  await page.evaluate(`document.querySelector('#atelier-bar [data-act="save"]').click()`)
  await page.waitForFunction(`document.getElementById('atelier-review')`, { timeout: 4000 })
  return page
}

test('Save opens a review instead of committing straight away', skip, async () => {
  const page = await reviewPage()
  assert.equal(
    await page.evaluate(`window.__sent.some((m) => m.t === 'record.saveFromPage')`),
    false,
    'nothing is saved until the review is confirmed',
  )
  await page.close()
})

test('the review lists every step, in order', skip, async () => {
  const page = await reviewPage()
  const rows = (await page.evaluate(
    `[...document.querySelectorAll('#atelier-review [data-step]')].length`,
  )) as number
  const actions = (await page.evaluate(`window.__actions().length`)) as number
  assert.equal(rows, actions, 'every recorded action is accounted for')
  await page.close()
})

test('the review shows the value each field will actually type', skip, async () => {
  // The whole point of a review: seeing the text, not a count of steps.
  const page = await reviewPage()
  const text = (await page.evaluate(`document.getElementById('atelier-review').textContent`)) as string
  assert.match(text, /You are a careful assistant\./)
  assert.match(text, /a harbour at dusk/)
  await page.close()
})

test('a field the agent fills in is shown as a named value, not as its example', skip, async () => {
  const page = await reviewPage()
  const text = (await page.evaluate(`document.getElementById('atelier-review').textContent`)) as string
  assert.match(text, /\{\{\s*\w+\s*\}\}|agent fills/i)
  await page.close()
})

test('the review can keep a value, without going back to the page', skip, async () => {
  const page = await reviewPage()
  await page.evaluate(`
    const box = document.querySelector('#atelier-review input[type="checkbox"]')
    box.checked = true
    box.dispatchEvent(new Event('change'))
  `)
  const sent = (await page.evaluate(
    `window.__sent.filter((m) => m.t === 'record.role')`,
  )) as any[]
  assert.equal(sent.length, 1)
  assert.equal(sent[0].role, 'fixed')
  await page.close()
})

test('confirming the review is what saves it', skip, async () => {
  const page = await reviewPage()
  await page.evaluate(`document.querySelector('#atelier-review [data-act="confirm"]').click()`)
  assert.equal(
    await page.evaluate(`window.__sent.some((m) => m.t === 'record.saveFromPage')`),
    true,
  )
  await page.waitForFunction(`!document.getElementById('atelier-review')`, { timeout: 2000 })
  await page.close()
})

test('backing out of the review leaves the recording running', skip, async () => {
  const page = await reviewPage()
  await page.evaluate(`document.querySelector('#atelier-review [data-act="back"]').click()`)
  await page.waitForFunction(`!document.getElementById('atelier-review')`, { timeout: 2000 })
  assert.equal(await page.evaluate(`!!document.getElementById('atelier-bar')`), true, 'the bar comes back')
  assert.equal(
    await page.evaluate(`window.__sent.some((m) => m.t === 'record.saveFromPage')`),
    false,
  )
  await page.close()
})

test('the review is big enough to read, and centred', skip, async () => {
  const page = await reviewPage()
  const box = (await page.evaluate(`
    (() => {
      const r = document.querySelector('#atelier-review .atelier-review-card').getBoundingClientRect()
      return { width: r.width, left: r.left, right: window.innerWidth - r.right }
    })()
  `)) as any
  assert.ok(box.width > 520, `the card is only ${Math.round(box.width)}px wide`)
  assert.ok(Math.abs(box.left - box.right) < 2, 'centred')
  await page.close()
})

/* ----------------------------------------- one field, one step, at record time */

/**
 * Typing is debounced per field, but any pause longer than the debounce emits a
 * second action — so a sentence typed with a thought in the middle of it arrived
 * as two steps, three if you went back to fix a word.
 *
 * `propose.ts` has always collapsed those, but only when the recording was
 * turned into a workflow. Everything a person looks at before that — the count
 * on the bar, the popup's list, the review — showed the raw bursts. Collapsing
 * in the worker makes the stored recording the thing it claims to be.
 */
const typedOn = (label: string, id: string, value: string, extra: Record<string, unknown> = {}) => ({
  kind: 'type',
  element: { tag: 'textarea', label, selectors: [{ strategy: 'id', value: id, score: 92 }] },
  value,
  ...extra,
})

async function workerRecording() {
  const page = await workerWith([])
  const add = async (action: unknown) =>
    (await page.evaluate(`window.__ask({ t: 'record.action', action: ${JSON.stringify(action)} })`)) as any
  return { page, add }
}

const stored = (page: any) =>
  page.evaluate(`window.__sessionStore['atelier:recording'].actions`)

test('two bursts of typing into one field are one step, with the finished text', skip, async () => {
  const { page, add } = await workerRecording()
  await add(typedOn('Prompt', '#prompt', 'a harbour'))
  await add(typedOn('Prompt', '#prompt', 'a harbour at dusk'))
  const actions = (await stored(page)) as any[]
  assert.equal(actions.length, 1)
  assert.equal(actions[0].value, 'a harbour at dusk', 'the last value is the complete one')
  await page.close()
})

test('the count stops climbing while you are still typing the same thing', skip, async () => {
  // The count is the only thing on the bar telling you the recorder is hearing
  // you. It should mean steps, not keystroke bursts.
  const { page, add } = await workerRecording()
  const first = await add(typedOn('Prompt', '#prompt', 'a'))
  const second = await add(typedOn('Prompt', '#prompt', 'a harbour at dusk'))
  assert.equal(first.count, 1)
  assert.equal(second.count, 1)
  await page.close()
})

test('going back to a field after doing something else stays two steps', skip, async () => {
  // Order is what replay follows. Typing, clicking, then typing into the same
  // field again is three things that happened, in that order.
  const { page, add } = await workerRecording()
  await add(typedOn('Prompt', '#prompt', 'a harbour'))
  await add({ kind: 'click', element: { tag: 'button', label: 'Run', selectors: [{ strategy: 'id', value: '#run', score: 92 }] } })
  await add(typedOn('Prompt', '#prompt', 'a harbour at dusk'))
  assert.equal(((await stored(page)) as any[]).length, 3)
  await page.close()
})

test('two different fields are two steps, however fast they follow each other', skip, async () => {
  const { page, add } = await workerRecording()
  await add(typedOn('Instructions', '#sys', 'setup'))
  await add(typedOn('Prompt', '#prompt', 'a harbour at dusk'))
  assert.equal(((await stored(page)) as any[]).length, 2)
  await page.close()
})

test('a kept value stays kept when you go back and fix a typo in it', skip, async () => {
  const { page, add } = await workerRecording()
  await add(typedOn('Instructions', '#sys', 'You are a carful assistant', { role: 'fixed' }))
  await add(typedOn('Instructions', '#sys', 'You are a careful assistant'))
  const actions = (await stored(page)) as any[]
  assert.equal(actions.length, 1)
  assert.equal(actions[0].role, 'fixed', 'the mark is on the field, not on one burst of typing')
  assert.equal(actions[0].value, 'You are a careful assistant')
  await page.close()
})

test('a password burst is never merged into a recorded value', skip, async () => {
  const { page, add } = await workerRecording()
  await add(typedOn('Password', '#pw', null as unknown as string, { secret: true }))
  await add(typedOn('Password', '#pw', null as unknown as string, { secret: true }))
  const actions = (await stored(page)) as any[]
  assert.equal(actions.length, 1)
  assert.equal(actions[0].value, null, 'nothing about a password is written down, merged or not')
  await page.close()
})

test('clicking into a field and then typing stays two steps', skip, async () => {
  // The ordinary way anyone fills in a form, and the case where a merge rule
  // keyed only on the element would swallow the click that focuses the field.
  const { page, add } = await workerRecording()
  const field = { tag: 'textarea', label: 'Prompt', selectors: [{ strategy: 'id', value: '#prompt', score: 92 }] }
  await add({ kind: 'click', element: field })
  await add({ kind: 'type', element: field, value: 'a harbour at dusk' })
  const actions = (await stored(page)) as any[]
  assert.deepEqual(
    actions.map((a) => a.kind),
    ['click', 'type'],
    'a merge is between two bursts of typing, not between anything on the same element',
  )
  await page.close()
})

/* ------------------------------------------- Enter inside a field is text */

/**
 * Enter in a textarea is a newline. Recording it as a step is wrong twice over:
 * it is not an action to replay — the typed value already contains the newline —
 * and it lands *between* two bursts of typing, which is what stopped them
 * merging. A multi-line value, which is exactly what a long setup field is,
 * therefore arrived as three steps however well the merge worked.
 */
async function typingPage(html: string) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 700 })
  await page.setContent(
    `<!doctype html><html><head><style>${OVERLAY_CSS}</style></head>
     <body style="padding-top:140px">${html}</body></html>`,
  )
  await page.evaluate(CHROME_STUB)
  await page.evaluate(RECORDER)
  await page.evaluate(`window.__tell({ t: 'record.begin', draftName: 't', mode: 'workflow', count: 0 })`)
  await page.waitForFunction(`document.getElementById('atelier-bar')`, { timeout: 4000 })
  return page
}

const kinds = (page: any) => page.evaluate(`window.__actions().map((a) => a.kind)`)

test('Enter inside a textarea is not a step — it is part of what was typed', skip, async () => {
  const page = await typingPage(`<textarea id="sys"></textarea>`)
  await page.click('#sys')
  await page.type('#sys', 'You are careful.')
  await page.keyboard.press('Enter')
  await page.type('#sys', 'Answer plainly.')
  await page.evaluate(`document.getElementById('sys').blur()`)
  // Typing is debounced at 600ms, so the step does not exist before then.
  await page.waitForFunction(`window.__actions().some((a) => a.kind === 'type')`, { timeout: 4000 })
  assert.equal(
    ((await kinds(page)) as string[]).includes('key'),
    false,
    'a newline is text, not a keystroke to replay',
  )
  const typed = (await page.evaluate(
    `window.__actions().filter((a) => a.kind === 'type').map((a) => a.value)`,
  )) as string[]
  assert.match(typed[typed.length - 1]!, /You are careful\.[\s\S]*Answer plainly\./)
  await page.close()
})

test('Enter in a single-line input is still a step, because it submits', skip, async () => {
  const page = await typingPage(`<input id="q">`)
  await page.click('#q')
  await page.type('#q', 'a harbour')
  await page.keyboard.press('Enter')
  await page.waitForFunction(`window.__actions().some((a) => a.kind === 'key')`, { timeout: 3000 })
  await page.close()
})

test('Enter outside any field is still a step', skip, async () => {
  const page = await typingPage(`<button id="go">Go</button>`)
  await page.click('#go')
  await page.keyboard.press('Enter')
  await page.waitForFunction(`window.__actions().some((a) => a.kind === 'key')`, { timeout: 3000 })
  await page.close()
})

test('Enter in a contenteditable is not a step either', skip, async () => {
  const page = await typingPage(`<div id="ed" contenteditable="true"></div>`)
  await page.click('#ed')
  await page.type('#ed', 'first line')
  await page.keyboard.press('Enter')
  await page.type('#ed', 'second line')
  await page.waitForFunction(`window.__actions().some((a) => a.kind === 'type')`, { timeout: 4000 })
  assert.equal(((await kinds(page)) as string[]).includes('key'), false)
  await page.close()
})

test('Tab is still recorded — it moves to the next field', skip, async () => {
  const page = await typingPage(`<textarea id="sys"></textarea><input id="q">`)
  await page.click('#sys')
  await page.type('#sys', 'setup')
  await page.keyboard.press('Tab')
  await page.waitForFunction(
    `window.__actions().some((a) => a.kind === 'key' && a.value === 'Tab')`,
    { timeout: 3000 },
  )
  await page.close()
})

test('a long multi-line value typed with pauses ends up as one step', skip, async () => {
  // The whole complaint, end to end: the real recorder feeding the real merge
  // rule. Newlines and pauses longer than the 600ms debounce both split the
  // typing; neither should reach the recording as a step of its own.
  const page = await typingPage(`<textarea id="sys"></textarea>`)
  await page.evaluate(`
    // The worker's rule, applied here so this exercises the recorder's output
    // rather than a hand-written action list.
    window.__recording = []
    const key = (el) => {
      const best = [...(el?.selectors ?? [])].sort((a, b) => b.score - a.score)[0]
      return best ? best.strategy + ':' + best.value : null
    }
    window.chrome.runtime.sendMessage = (msg, cb) => {
      window.__sent.push(msg)
      if (msg.t === 'record.action') {
        const a = msg.action
        const prev = window.__recording[window.__recording.length - 1]
        const merges = prev && prev.kind === 'type' && a.kind === 'type' &&
          prev.secret === a.secret && key(a.element) && key(a.element) === key(prev.element)
        if (merges) window.__recording[window.__recording.length - 1] = a
        else window.__recording.push(a)
      }
      cb && cb({ ok: true, count: window.__recording.length })
    }
  `)

  await page.click('#sys')
  await page.type('#sys', 'You are a careful assistant.')
  await page.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 800)) // longer than the debounce
  await page.type('#sys', 'Answer in plain language.')
  await page.evaluate(`document.getElementById('sys').blur()`)
  await new Promise((r) => setTimeout(r, 900))

  const recording = (await page.evaluate(`window.__recording`)) as any[]
  const typed = recording.filter((a) => a.kind === 'type')
  assert.equal(typed.length, 1, `expected one typing step, got ${recording.map((a) => a.kind).join(', ')}`)
  assert.match(typed[0].value, /You are a careful assistant\.[\s\S]*Answer in plain language\./)
  assert.equal(
    recording.some((a) => a.kind === 'key'),
    false,
    'and no stray keystroke steps between them',
  )
  await page.close()
})

/* ---------------------------------------------------------- moving the bar */

/**
 * The bar sits over the page being recorded, which means it sits over something
 * the person needs to click. Being able to move it is the fix; being unable to
 * lose it off an edge is what makes moving it safe.
 */
const barBox = (page: any) =>
  page.evaluate(`
    (() => {
      const r = document.getElementById('atelier-bar').getBoundingClientRect()
      return { left: r.left, top: r.top, width: r.width, height: r.height,
               vw: window.innerWidth, vh: window.innerHeight }
    })()
  `)

/** A drag, as a sequence of pointer events on the bar's own background. */
async function dragBar(page: any, toX: number, toY: number, from = '.atelier-name') {
  await page.evaluate(
    `(() => {
      const bar = document.getElementById('atelier-bar')
      const grip = bar.querySelector('${from}') || bar
      const r = grip.getBoundingClientRect()
      const at = (type, x, y) => grip.dispatchEvent(
        new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1 }),
      )
      at('pointerdown', r.left + 4, r.top + 4)
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: ${toX}, clientY: ${toY}, bubbles: true, pointerId: 1 }))
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: ${toX}, clientY: ${toY}, bubbles: true, pointerId: 1 }))
    })()`,
  )
}

test('the bar can be dragged somewhere else', skip, async () => {
  const page = await barPage()
  const before = (await barBox(page)) as any
  await dragBar(page, 200, 400)
  const after = (await barBox(page)) as any
  assert.ok(Math.abs(after.top - before.top) > 100, 'it should have moved')
  await page.close()
})

test('it cannot be dragged off the top or the left', skip, async () => {
  const page = await barPage()
  await dragBar(page, -900, -900)
  const box = (await barBox(page)) as any
  assert.ok(box.left >= 0, `left is ${Math.round(box.left)}`)
  assert.ok(box.top >= 0, `top is ${Math.round(box.top)}`)
  await page.close()
})

test('it cannot be dragged off the bottom or the right', skip, async () => {
  const page = await barPage()
  await dragBar(page, 9000, 9000)
  const box = (await barBox(page)) as any
  assert.ok(box.left + box.width <= box.vw, 'the right edge stays on screen')
  assert.ok(box.top + box.height <= box.vh, 'the bottom edge stays on screen')
  await page.close()
})

test('shrinking the window brings the bar back inside it', skip, async () => {
  // Dragged to the far corner, then the window gets smaller — the bar would
  // otherwise be sitting outside a viewport it used to fit in.
  const page = await barPage(1200)
  await dragBar(page, 9000, 9000)
  await page.setViewport({ width: 700, height: 420 })
  await page.evaluate(`window.dispatchEvent(new Event('resize'))`)
  await new Promise((r) => setTimeout(r, 120))
  const box = (await barBox(page)) as any
  assert.ok(box.left + box.width <= box.vw + 1, 'still inside after the resize')
  assert.ok(box.top + box.height <= box.vh + 1, 'still inside after the resize')
  await page.close()
})

test('dragging from a control does not move the bar, so the controls still work', skip, async () => {
  const page = await barPage()
  const before = (await barBox(page)) as any
  await dragBar(page, 200, 500, '[data-act="undo"]')
  const after = (await barBox(page)) as any
  assert.equal(Math.round(after.top), Math.round(before.top))
  assert.equal(Math.round(after.left), Math.round(before.left))
  await page.close()
})

/**
 * A page on a real origin.
 *
 * `setContent` leaves the page on about:blank, whose origin is opaque — every
 * `sessionStorage` access there throws SecurityError. The recorder survives that
 * by design, which is why the rest of this suite never noticed; a test about
 * remembering something has to be somewhere that can remember.
 */
async function barPageOnOrigin() {
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 700 })
  await page.setRequestInterception(true)
  page.on('request', (req: any) => {
    if (req.url().startsWith('http://atelier.test/')) {
      req.respond({
        contentType: 'text/html',
        body: `<!doctype html><html><head><style>${OVERLAY_CSS}</style></head><body></body></html>`,
      })
    } else {
      req.continue()
    }
  })
  await page.goto('http://atelier.test/', { waitUntil: 'domcontentloaded' })
  await page.evaluate(CHROME_STUB)
  await page.evaluate(RECORDER)
  await page.evaluate(
    `window.__tell({ t: 'record.begin', draftName: 'audio-generation', mode: 'workflow', count: 0 })`,
  )
  await page.waitForFunction(`document.getElementById('atelier-bar')`, { timeout: 4000 })
  return page
}

test('where you put it survives the bar being rebuilt', skip, async () => {
  // A navigation destroys the content script and the bar is injected again. A
  // bar that jumps back to the middle every time the page moves has not really
  // been moved.
  const page = await barPageOnOrigin()
  await dragBar(page, 120, 380)
  const moved = (await barBox(page)) as any
  await page.evaluate(`window.__tell({ t: 'record.end' })`)
  await page.evaluate(`window.__tell({ t: 'record.begin', draftName: 'audio-generation', mode: 'workflow', count: 3 })`)
  await page.waitForFunction(`document.getElementById('atelier-bar')`, { timeout: 3000 })
  const again = (await barBox(page)) as any
  assert.equal(Math.round(again.top), Math.round(moved.top))
  assert.equal(Math.round(again.left), Math.round(moved.left))
  await page.close()
})
