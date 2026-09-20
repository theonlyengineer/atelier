/**
 * The control panel and the replay engine, in a real browser.
 *
 * These two files are the ones that cannot be tested any other way, and they
 * are exactly the two where the expensive bugs have always lived. They are also
 * one file's worth of behaviour twice over now, because the panel performs each
 * step *through* the replay engine as it is recorded — so a bug in the executor
 * shows up while somebody is still looking at the page rather than a week later
 * on the first run.
 *
 * The content scripts expect a `chrome.runtime`; a small stub stands in for the
 * service worker and holds the recording the panel is editing. Everything else
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
const OVERLAY_CSS = readFileSync(join(EXT, 'overlay.css'), 'utf-8')

/**
 * Stands in for the service worker.
 *
 * It holds the recording, because that is where the recording really lives —
 * the panel reads it back after every change rather than keeping its own copy,
 * so a stub that merely collected messages would not exercise the loop that
 * actually runs.
 */
const CHROME_STUB = `
  window.__sent = []
  window.__listeners = []
  window.__rec = {
    mode: 'workflow', name: 'test', tabId: 1,
    origins: [location.origin], startUrl: location.href, steps: [],
  }
  window.chrome = {
    runtime: {
      // Real Chrome always has an id; it goes undefined only when the context
      // has been invalidated, which is exactly what the panel checks for.
      id: 'test-extension-id',
      lastError: undefined,
      sendMessage: (msg, cb) => {
        window.__sent.push(msg)
        let res = { ok: true }
        if (msg.t === 'record.state') res = { recording: window.__rec }
        else if (msg.t === 'record.name') { window.__rec.name = msg.name }
        else if (msg.t === 'record.addStep') {
          window.__rec.steps.push(msg.step)
          res = { ok: true, steps: window.__rec.steps.length }
        }
        else if (msg.t === 'record.restart') { window.__rec.steps = [] }
        else if (msg.t === 'record.setStepValue') {
          Object.assign(window.__rec.steps[msg.index], msg.patch)
        }
        cb && cb(res)
      },
      onMessage: { addListener: (fn) => window.__listeners.push(fn) },
    },
  }
  window.__tell = (msg) => new Promise((r) => {
    let answered = false
    for (const fn of window.__listeners) fn(msg, null, (res) => { if (!answered) { answered = true; r(res) } })
    setTimeout(() => { if (!answered) r(null) }, 50)
  })
  window.__steps = () => window.__rec.steps
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

const skip = { skip: CHROME ? false : 'no Chrome on this machine' }

/** A page with the panel open on it, exactly as the worker would leave one. */
async function pageWith(html: string, rec: Record<string, unknown> = {}) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 800 })
  await page.setContent(
    `<!doctype html><html><head><style>${OVERLAY_CSS}</style></head><body>${html}</body></html>`,
  )
  await page.evaluate(CHROME_STUB)
  if (Object.keys(rec).length) await page.evaluate(`Object.assign(window.__rec, ${JSON.stringify(rec)})`)
  // replay.js first, because the panel performs each step through it.
  await page.evaluate(REPLAY)
  await page.evaluate(RECORDER)
  await page.evaluate(`window.__tell({ t: 'record.begin', recording: window.__rec })`)
  return page
}

/** Point at an element and let the composer come back with it. */
async function pointAt(page: any, selector: string) {
  await page.click('#atelier-root [data-act="pick"]')
  await page.click(selector)
  await page.waitForSelector('#atelier-root .at-card')
}

const compose = (page: any, script: string) => page.evaluate(script)

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


/* ------------------------------------------------- replay, the new verbs */

test('a tick is set rather than toggled, so a box that starts the other way round still ends right', skip, async () => {
  const page = await replayPage(`<input type="checkbox" id="opt" checked>`)
  const result = (await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'check', timeoutMs: 1000, target: 'Remember me',
    selectors: [{ strategy: 'id', value: '#opt', score: 92 }],
  })`)) as any
  assert.equal(result.ok, true)
  // Already ticked. A toggle would have unticked it, which is the opposite of
  // what was recorded — and a bug that only appears on somebody else's account.
  assert.equal(await page.evaluate(`document.querySelector('#opt').checked`), true)
  await page.close()
})

test('untick sets it off from either starting state', skip, async () => {
  const page = await replayPage(`<input type="checkbox" id="opt">`)
  await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'uncheck', timeoutMs: 1000,
    selectors: [{ strategy: 'id', value: '#opt', score: 92 }],
  })`)
  assert.equal(await page.evaluate(`document.querySelector('#opt').checked`), false)
  await page.close()
})

test('a choice is matched on the option text, which is the part the person read', skip, async () => {
  const page = await replayPage(
    `<select id="size"><option value="s">Small</option><option value="l">Large</option></select>`,
  )
  await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'select', timeoutMs: 1000, value: 'Large',
    selectors: [{ strategy: 'id', value: '#size', score: 92 }],
  })`)
  assert.equal(await page.evaluate(`document.querySelector('#size').value`), 'l')
  await page.close()
})

test('capturing a placeholder reads the placeholder, not what is in the field', skip, async () => {
  const page = await replayPage(`<input id="q" placeholder="Search the archive" value="typed text">`)
  const result = (await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'capture', timeoutMs: 1000,
    capture: { as: 'text', from: 'placeholder' },
    selectors: [{ strategy: 'id', value: '#q', score: 92 }],
  })`)) as any
  assert.equal(result.capture.value, 'Search the archive')
  await page.close()
})

test('capturing a field reads what is in it', skip, async () => {
  const page = await replayPage(`<input id="q" placeholder="Search" value="what was typed">`)
  const result = (await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'capture', timeoutMs: 1000,
    capture: { as: 'text', from: 'value' },
    selectors: [{ strategy: 'id', value: '#q', score: 92 }],
  })`)) as any
  assert.equal(result.capture.value, 'what was typed')
  await page.close()
})

test('replay never resolves onto Atelier’s own furniture', skip, async () => {
  // The panel is in the document while a step is being recorded, and the step
  // is performed through this same executor at that moment. A text selector
  // looking for Save would otherwise find the panel’s own Save button.
  const page = await replayPage(
    `<div id="atelier-root"><button onclick="document.body.dataset.hit='ours'">Save workflow</button></div>
     <button id="real" onclick="document.body.dataset.hit='page'">Save workflow</button>`,
  )
  const result = (await page.evaluate(`window.__atelierReplay({
    id: 's', kind: 'click', timeoutMs: 800,
    selectors: [{ strategy: 'text', value: 'Save workflow', score: 96 }],
  })`)) as any
  assert.equal(result.ok, true)
  assert.equal(await page.evaluate(`document.body.dataset.hit`), 'page')
  await page.close()
})

/* -------------------------------------------------------- the launcher */

test('collapsed, Atelier is one square with an A in it', skip, async () => {
  const page = await pageWith(`<button id="go">Generate</button>`)
  await page.click('#atelier-root [data-act="collapse"]')
  assert.equal(await page.evaluate(`document.querySelector('#atelier-panel').hidden`), true)
  const glyph = await page.evaluate(`document.querySelector('#atelier-launcher .at-glyph').textContent`)
  assert.equal(glyph, 'A')
  await page.close()
})

test('the launcher opens the panel, and the panel is most of the window', skip, async () => {
  const page = await pageWith(`<button id="go">Generate</button>`)
  await page.click('#atelier-root [data-act="collapse"]')
  await page.click('#atelier-launcher')
  const box = await page.evaluate(`(() => {
    const r = document.querySelector('#atelier-panel').getBoundingClientRect()
    return { w: r.width, h: r.height, vh: window.innerHeight }
  })()`)
  assert.ok((box as any).h / (box as any).vh > 0.85, 'about nine tenths of the window, vertically')
  assert.ok((box as any).w >= 500, 'wide enough that a step box does not become a column of single words')
  await page.close()
})

test('the launcher can be dragged, and cannot be dragged out of the window', skip, async () => {
  const page = await pageWith(`<button id="go">Generate</button>`)
  await page.click('#atelier-root [data-act="collapse"]')
  const start = await page.evaluate(`(() => {
    const r = document.querySelector('#atelier-launcher').getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  await page.mouse.move((start as any).x, (start as any).y)
  await page.mouse.down()
  // Far past the top left corner. A fixed overlay pushed past an edge is not
  // scrolled back by anything, so it would simply be gone.
  await page.mouse.move(-500, -500, { steps: 6 })
  await page.mouse.up()
  const box = await page.evaluate(`(() => {
    const r = document.querySelector('#atelier-launcher').getBoundingClientRect()
    return { left: r.left, top: r.top }
  })()`)
  assert.ok((box as any).left >= 0 && (box as any).top >= 0, 'clamped back inside')
  await page.close()
})

/* ----------------------------------------------------------- composing */

test('pointing at a button proposes its text as the name', skip, async () => {
  const page = await pageWith(`<button id="go">Generate image</button>`)
  await pointAt(page, '#go')
  const name = await page.evaluate(`document.querySelector('#atelier-root .at-card .at-input').value`)
  assert.equal(name, 'Generate image')
  await page.close()
})

test('pointing at a field proposes what it asks for, not what is in it', skip, async () => {
  const page = await pageWith(`<input id="p" placeholder="Describe the image" value="a rope bridge">`)
  await pointAt(page, '#p')
  const name = await page.evaluate(`document.querySelector('#atelier-root .at-card .at-input').value`)
  assert.equal(name, 'Describe the image')
  await page.close()
})

test('the actions offered are the ones that element can actually take', skip, async () => {
  const page = await pageWith(
    `<button id="go">Generate</button>
     <input id="p" placeholder="Prompt">
     <input id="c" type="checkbox">
     <img id="out" src="https://example.test/x.png" alt="Result">`,
  )
  const actionsFor = async (selector: string) => {
    await pointAt(page, selector)
    const ids = await page.evaluate(
      `[...document.querySelectorAll('#atelier-root [data-role="action"] option')].map(o => o.value)`,
    )
    await page.click('#atelier-root [data-act="cancel"]')
    return ids as string[]
  }

  const button = await actionsFor('#go')
  assert.equal(button[0], 'click', 'the first action offered is the obvious one for the element')
  assert.ok(!button.includes('type'), 'a button cannot be typed into')
  assert.ok(!button.includes('check'), 'and it is not a checkbox')

  const field = await actionsFor('#p')
  assert.equal(field[0], 'type')
  assert.ok(field.includes('clear'))
  assert.ok(field.includes('capture_placeholder'))

  const box = await actionsFor('#c')
  assert.ok(box.includes('check') && box.includes('uncheck'))
  assert.ok(!box.includes('type'))

  const image = await actionsFor('#out')
  assert.equal(image[0], 'capture_media')
  await page.close()
})

test('a password offers only the step that stops and hands the keyboard back', skip, async () => {
  const page = await pageWith(`<input id="pw" type="password" placeholder="Password">`)
  await page.evaluate(`document.querySelector('#pw').value = 'hunter2'`)
  await pointAt(page, '#pw')
  const ids = await page.evaluate(
    `[...document.querySelectorAll('#atelier-root [data-role="action"] option')].map(o => o.value)`,
  )
  assert.deepEqual(ids, ['manual'])
  await page.click('#atelier-root [data-act="add"]')
  await page.waitForFunction(`window.__steps().length === 1`)
  const step = await page.evaluate(`window.__steps()[0]`)
  assert.equal((step as any).kind, 'manual')
  // Not the value, and not inside a selector either.
  assert.ok(!JSON.stringify(step).includes('hunter2'))
  await page.close()
})

/* ------------------------------------------------------ adding a step */

test('Atelier performs the step, so the page is where a real run would leave it', skip, async () => {
  const page = await pageWith(
    `<button id="go" onclick="document.body.dataset.clicked='yes'">Generate</button>`,
  )
  await pointAt(page, '#go')
  await page.click('#atelier-root [data-act="add"]')
  await page.waitForFunction(`window.__steps().length === 1`)
  assert.equal(await page.evaluate(`document.body.dataset.clicked`), 'yes')
  await page.close()
})

test('typing a step types it, and the recorded value is what was typed', skip, async () => {
  const page = await pageWith(`<input id="p" placeholder="Prompt">`)
  await pointAt(page, '#p')
  await page.evaluate(`(() => {
    const area = document.querySelector('#atelier-root .at-area')
    area.value = 'a rope bridge'
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await page.click('#atelier-root [data-act="add"]')
  await page.waitForFunction(`window.__steps().length === 1`)
  assert.equal(await page.evaluate(`document.querySelector('#p').value`), 'a rope bridge')
  const step = (await page.evaluate(`window.__steps()[0]`)) as any
  assert.equal(step.sampleValue, 'a rope bridge')
  assert.equal(step.valueMode, 'static', 'kept by default, because the agent must not be handed setup')
  await page.close()
})

test('a step that cannot be performed is refused, while there is still somebody looking at the page', skip, async () => {
  const page = await pageWith(`<button id="go">Generate</button>`)
  await pointAt(page, '#go')
  // Rename it to something the page has never heard of, and take the element
  // away, so neither the name nor the fallbacks can find anything.
  await page.evaluate(`(() => {
    const input = document.querySelector('#atelier-root .at-card .at-input')
    input.value = 'Nothing like this'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('#go').remove()
  })()`)
  await page.click('#atelier-root [data-act="add"]')
  await page.waitForSelector('#atelier-root .at-error')
  assert.equal(await page.evaluate(`window.__steps().length`), 0, 'nothing was kept')
  await page.close()
})

test('a name the page does not answer to is still the step name, and the fallbacks still find it', skip, async () => {
  const page = await pageWith(`<button id="go" data-testid="generate">Generate</button>`)
  await pointAt(page, '#go')
  await page.evaluate(`(() => {
    const input = document.querySelector('#atelier-root .at-card .at-input')
    input.value = 'The big orange button'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await page.click('#atelier-root [data-act="add"]')
  await page.waitForFunction(`window.__steps().length === 1`)
  const step = (await page.evaluate(`window.__steps()[0]`)) as any
  assert.equal(step.target, 'The big orange button')
  // No identifier selector: keeping one that does not resolve would read as
  // decay forever afterwards.
  assert.equal(step.identifier, null)
  assert.ok(step.selectors.some((s: any) => s.strategy === 'testid'))
  await page.close()
})

test('the panel never records itself', skip, async () => {
  const page = await pageWith(`<button id="go">Generate</button>`)
  await page.click('#atelier-root [data-act="pick"]')
  // A click on our own furniture while pointing is not a choice about the page.
  await page.click('#atelier-launcher')
  assert.equal(
    await page.evaluate(`document.documentElement.classList.contains('at-picking')`),
    true,
    'still armed, still waiting for a real target',
  )
  await page.close()
})

/* --------------------------------------------------------- the pipeline */

test('the steps read bottom to top, numbered in the order they run', skip, async () => {
  const page = await pageWith(`<button id="a">First</button><button id="b">Second</button>`)
  await pointAt(page, '#a')
  await page.click('#atelier-root [data-act="add"]')
  await page.waitForFunction(`window.__steps().length === 1`)
  await pointAt(page, '#b')
  await page.click('#atelier-root [data-act="add"]')
  await page.waitForFunction(`window.__steps().length === 2`)

  const order = await page.evaluate(
    `[...document.querySelectorAll('#atelier-root .at-step')].map(li => li.querySelector('.at-node').textContent)`,
  )
  // Newest at the top, directly under the composer that made it; step one at
  // the bottom, so the sequence still reads as one line.
  assert.deepEqual(order, ['2', '1'])
  await page.close()
})

test('each step box says what it acts on and what it does', skip, async () => {
  const page = await pageWith(`<button id="go">Generate image</button>`)
  await pointAt(page, '#go')
  await page.click('#atelier-root [data-act="add"]')
  await page.waitForSelector('#atelier-root .at-step')
  const rows = await page.evaluate(
    `[...document.querySelectorAll('#atelier-root .at-step .at-row')].map(r =>
      [r.querySelector('.at-k').textContent, r.querySelector('.at-v').textContent])`,
  )
  assert.deepEqual(rows, [['Target', 'Generate image'], ['Action', 'Click it']])
  await page.close()
})

test('a step cannot be removed on its own — starting over is the only way back', skip, async () => {
  const page = await pageWith(`<button id="go">Generate</button>`)
  await pointAt(page, '#go')
  await page.click('#atelier-root [data-act="add"]')
  await page.waitForSelector('#atelier-root .at-step')

  const removers = await page.evaluate(
    `document.querySelectorAll('#atelier-root .at-step [data-act="remove"], #atelier-root .at-step [data-remove]').length`,
  )
  assert.equal(removers, 0, 'no per-step delete anywhere')

  await page.click('#atelier-root [data-act="restart"]')
  await page.waitForSelector('#atelier-root .at-modal:not([hidden])')
  await page.click('#atelier-root .at-modal .at-danger')
  await page.waitForFunction(`window.__steps().length === 0`)
  await page.close()
})

test('an action cannot be changed after the fact, but a value can', skip, async () => {
  const page = await pageWith(`<input id="p" placeholder="Prompt">`)
  await pointAt(page, '#p')
  await page.evaluate(`(() => {
    const area = document.querySelector('#atelier-root .at-area')
    area.value = 'a rope bridge'
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await page.click('#atelier-root [data-act="add"]')
  await page.waitForSelector('#atelier-root .at-step')

  // No way back to the action.
  assert.equal(
    await page.evaluate(`document.querySelectorAll('#atelier-root .at-step [data-role="action"]').length`),
    0,
  )

  await page.click('#atelier-root .at-step [data-edit]')
  await page.waitForSelector('#atelier-root .at-edit')
  await page.click('#atelier-root .at-edit [data-mode="dynamic"]')
  await page.waitForSelector('#atelier-root .at-edit [data-role="edit-name"]')
  await page.evaluate(`(() => {
    const area = document.querySelector('#atelier-root .at-edit [data-role="edit-value"]')
    area.value = 'a rope bridge with its planks missing'
  })()`)
  await page.click('#atelier-root .at-edit [data-save-edit]')
  await page.waitForFunction(`window.__steps()[0].valueMode === 'dynamic'`)
  const step = (await page.evaluate(`window.__steps()[0]`)) as any
  assert.equal(step.valueMode, 'dynamic')
  assert.equal(step.sampleValue, 'a rope bridge with its planks missing')
  await page.close()
})

test('a dynamic value keeps the text it was recorded with, for a test run', skip, async () => {
  const page = await pageWith(`<input id="p" placeholder="Prompt">`)
  await pointAt(page, '#p')
  await page.evaluate(`(() => {
    const area = document.querySelector('#atelier-root .at-area')
    area.value = 'a rope bridge'
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await page.click('#atelier-root [data-mode="dynamic"]')
  await page.waitForSelector('#atelier-root .at-sub-field')
  await page.click('#atelier-root [data-act="add"]')
  await page.waitForFunction(`window.__steps().length === 1`)
  const step = (await page.evaluate(`window.__steps()[0]`)) as any
  assert.equal(step.valueMode, 'dynamic')
  assert.equal(step.sampleValue, 'a rope bridge', 'kept, so a test run has something real to type')
  assert.equal(step.inputName, 'prompt')
  await page.close()
})

/* ------------------------------------------------------------ dialogs */

test('an unnamed recording asks for a name in the page, in Atelier’s own dialog', skip, async () => {
  const page = await pageWith(`<button id="go">Generate</button>`, { name: '' })
  await page.waitForSelector('#atelier-root .at-modal:not([hidden])')
  const title = await page.evaluate(`document.querySelector('#atelier-root .at-modal h2').textContent`)
  assert.match(title as string, /name this workflow/i)
  await page.evaluate(`(() => {
    const input = document.querySelector('#atelier-root .at-modal .at-input')
    input.value = 'Export invoices'
  })()`)
  await page.click('#atelier-root .at-modal .at-primary')
  // The name goes to the worker as typed; turning it into a slug is the
  // worker's job, so that one rule lives in one place rather than in every
  // surface that can ask for a name.
  await page.waitForFunction(`window.__sent.some(m => m.t === 'record.name')`)
  const named = (await page.evaluate(`window.__sent.find(m => m.t === 'record.name')`)) as any
  assert.equal(named.name, 'Export invoices')
  await page.close()
})

test('nothing in the panel reaches for the browser’s own prompt, confirm or alert', skip, async () => {
  // They are modal to the whole tab, cannot be styled, and read as though the
  // *site* is asking at the exact moment the question is about Atelier.
  const source = readFileSync(join(EXT, 'recorder.js'), 'utf-8')
  for (const banned of ['window.prompt(', 'window.confirm(', 'window.alert(', /(^|[^.\w])confirm\(/]) {
    if (typeof banned === 'string') assert.ok(!source.includes(banned), `found ${banned}`)
    else assert.ok(!banned.test(source), 'found a bare confirm(')
  }
})

/* -------------------------------------------------------------- popup */

const PANEL_DIR = join(HERE, '..', '..', 'extension', 'src', 'panel')
const PANEL_HTML = readFileSync(join(PANEL_DIR, 'panel.html'), 'utf-8')
const PANEL_JS = readFileSync(join(PANEL_DIR, 'panel.js'), 'utf-8')
const PANEL_CSS = readFileSync(join(PANEL_DIR, 'panel.css'), 'utf-8')

/**
 * The popup, with both the worker and the daemon stubbed.
 *
 * It talks to the daemon over HTTP directly and to the worker for anything that
 * needs tabs, so both are replaced and what is asserted is what gets rendered
 * and what gets dispatched.
 */
async function popupWith(workflows: unknown[], origin = 'https://example.test') {
  const page = await browser.newPage()
  await page.setContent(PANEL_HTML.replace(/<script[\s\S]*?<\/script>/, ''))
  await page.addStyleTag({ content: PANEL_CSS })
  await page.evaluate(`
    window.__sent = []
    window.chrome = {
      runtime: {
        id: 'x',
        sendMessage: (msg) => { window.__sent.push(msg); return Promise.resolve({ recording: null, state: {} }) },
        onMessage: { addListener: () => {} },
      },
      tabs: { query: async () => [{ id: 1, url: ${JSON.stringify(origin)} + '/somewhere' }], create: () => {} },
      permissions: { contains: async () => true, request: async () => true },
    }
    window.close = () => { window.__closed = true }
    window.fetch = async (url) => ({
      ok: true,
      json: async () => url.indexOf('/health') >= 0
        ? { ok: true }
        : { ok: true, result: { jobs: [], browsers: [{ label: 'chrome' }], workflows: ${JSON.stringify(workflows)} } },
    })
  `)
  await page.evaluate(PANEL_JS)
  await page.waitForFunction(`document.querySelectorAll('#here li, #here-empty:not([hidden])').length > 0`)
  return page
}

const wf = (name: string, origins: string[], over: Record<string, unknown> = {}) => ({
  name,
  status: 'active',
  produces: 'image',
  steps: 4,
  origins,
  inputs: [],
  health: { state: 'ok' },
  ...over,
})

test('the popup lists the workflows of the page you are on, and counts the rest', skip, async () => {
  const page = await popupWith([
    wf('generate-image', ['https://example.test']),
    wf('export-invoices', ['https://elsewhere.test']),
    wf('fetch-report', ['https://elsewhere.test']),
  ])
  const listed = await page.evaluate(
    `[...document.querySelectorAll('#here .wf-name')].map(e => e.textContent)`,
  )
  assert.deepEqual(listed, ['generate-image'])
  const rest = await page.evaluate(`document.getElementById('elsewhere').textContent`)
  assert.match(rest as string, /2 more workflows elsewhere/)
  await page.close()
})

test('the popup says which site it is filtering by, so the filter is never a mystery', skip, async () => {
  const page = await popupWith([wf('generate-image', ['https://example.test'])])
  const label = await page.evaluate(`document.getElementById('here-label').textContent`)
  assert.equal(label, 'On example.test')
  await page.close()
})

test('a workflow row opens its page on the dashboard rather than expanding in the popup', skip, async () => {
  const page = await popupWith([wf('generate-image', ['https://example.test'])])
  await page.evaluate(`window.__opened = null; chrome.tabs.create = (o) => { window.__opened = o.url }`)
  await page.click('#here .wf-head')
  const url = await page.evaluate(`window.__opened`)
  assert.match(url as string, /#workflow\/generate-image$/)
  await page.close()
})

test('starting a recording closes the popup, because the name is asked for in the page', skip, async () => {
  const page = await popupWith([])
  await page.click('#record')
  await page.waitForFunction(`window.__closed === true`)
  const sent = (await page.evaluate(`window.__sent.map(m => m.t)`)) as string[]
  assert.ok(sent.includes('panel.record.start'))
  // The name is not asked for here, so nothing carries one.
  const start = (await page.evaluate(`window.__sent.find(m => m.t === 'panel.record.start')`)) as any
  assert.equal(start.name, undefined)
  await page.close()
})

test('the popup has no getting-started section and no unnecessary status line', skip, async () => {
  // Both were teaching surfaces in a window that closes when it loses focus.
  // The first screen a new user sees is now the one on the page they opened it
  // over, which is where the answer actually is.
  assert.ok(!/Getting started/i.test(PANEL_HTML))
  assert.ok(!/id="stamp"/.test(PANEL_HTML))
  assert.ok(!/id="first-run"/.test(PANEL_HTML))
})

test('nothing in the popup reaches for the browser’s own alert or confirm', skip, async () => {
  assert.ok(!/(^|[^.\w])alert\(/.test(PANEL_JS), 'found a bare alert(')
  assert.ok(!/(^|[^.\w])confirm\(/.test(PANEL_JS), 'found a bare confirm(')
  assert.ok(!/window\.prompt\(/.test(PANEL_JS))
})

test('a decaying step can be repointed from the popup, which is where the page is', skip, async () => {
  // Repointing needs the site open, and the popup is the surface you reach for
  // while standing on it. The dashboard names this control, so it has to exist.
  const page = await popupWith([
    wf('generate-image', ['https://example.test'], {
      health: {
        state: 'degraded',
        summary: '1 of 4 steps is matching on a weaker selector than recorded',
        degraded: [{ stepId: 's2', note: 'Click Generate', detail: 'now matching on position' }],
      },
    }),
  ])
  const note = await page.evaluate(`document.querySelector('#here .step-note').textContent`)
  assert.equal(note, 'Click Generate')

  await page.evaluate(`window.__closed = false`)
  await page.click('#here .step-row button')
  await page.waitForFunction(`window.__sent.some(m => m.t === 'panel.step.repoint')`)
  const sent = (await page.evaluate(`window.__sent.find(m => m.t === 'panel.step.repoint')`)) as any
  assert.equal(sent.workflowName, 'generate-image')
  assert.equal(sent.stepId, 's2')
  await page.close()
})

test('a healthy workflow offers no repair, so a control is never a control that does nothing', skip, async () => {
  const page = await popupWith([wf('generate-image', ['https://example.test'])])
  assert.equal(await page.evaluate(`document.querySelectorAll('#here .step-row').length`), 0)
  await page.close()
})

/* ------------------------------------------------------- the top layer */

/**
 * A site's own overlay must not bury the panel.
 *
 * The reason it could is worth stating, because the fix looks like
 * over-engineering until you know it: `showModal()` and the popover API put an
 * element in the **top layer**, which paints above every z-index there is.
 * 2147483647 is the largest integer CSS will take and it loses to the top layer
 * every time. So the only way to sit above a site's modal is to be in the top
 * layer too.
 */

/** Where the launcher is, in viewport coordinates. */
const launcherPoint = (page: any) =>
  page.evaluate(`(() => {
    const r = document.querySelector('#atelier-launcher').getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)

/**
 * Move the mouse the way a hand does.
 *
 * The check that notices being buried is throttled, because it runs on every
 * pointermove and a person reaching for the launcher generates dozens of those.
 * Two `mouse.move` calls back to back land inside one window and look, to the
 * panel, like a single twitch — so this puts real time between them, which is
 * what a hand crossing a screen actually does.
 */
async function reachFor(page: any, point: { x: number; y: number }) {
  await page.mouse.move(point.x - 60, point.y - 60)
  await new Promise((r) => setTimeout(r, 320))
  await page.mouse.move(point.x - 20, point.y - 20)
  await new Promise((r) => setTimeout(r, 320))
  await page.mouse.move(point.x, point.y)
}

/** Whether Atelier is the topmost thing at a point, which is the only question. */
const onTopAt = (page: any, point: { x: number; y: number }) =>
  page.evaluate(`(() => {
    const hit = document.elementFromPoint(${point.x}, ${point.y})
    return !!hit && !!hit.closest('#atelier-root')
  })()`)

test('the panel sits above a site overlay with the largest z-index there is', skip, async () => {
  const page = await pageWith(
    `<button id="go">Generate</button>
     <div id="sheet" style="position:fixed;inset:0;z-index:2147483647;background:#000"></div>`,
  )
  await page.click('#atelier-root [data-act="collapse"]')
  assert.equal(await onTopAt(page, (await launcherPoint(page)) as any), true)
  await page.close()
})

test('and above a modal dialog, which no z-index can beat', skip, async () => {
  const page = await pageWith(`<button id="go">Generate</button><dialog id="sheet">Settings</dialog>`)
  await page.click('#atelier-root [data-act="collapse"]')
  // Opened *after* the panel, which is the hard direction: the top layer is a
  // stack, and whatever entered it last is on top.
  await page.evaluate(`document.querySelector('#sheet').showModal()`)

  const point = (await launcherPoint(page)) as any
  // The mouse moving is the signal that somebody is about to reach for it, and
  // is what makes this self-healing rather than needing a click to fix.
  await reachFor(page, point)
  await page.waitForFunction(
    `(() => { const h = document.elementFromPoint(${point.x}, ${point.y}); return !!h && !!h.closest('#atelier-root') })()`,
    { timeout: 4000 },
  )
  await page.close()
})

test('and is still clickable under one, not merely visible', skip, async () => {
  // A modal dialog makes the rest of the document inert. Being painted on top
  // of one while being unable to receive a click is the worse failure of the
  // two, because it looks fixed.
  const page = await pageWith(`<button id="go">Generate</button><dialog id="sheet">Settings</dialog>`)
  await page.click('#atelier-root [data-act="collapse"]')
  await page.evaluate(`document.querySelector('#sheet').showModal()`)

  const point = (await launcherPoint(page)) as any
  await reachFor(page, point)
  await page.mouse.click(point.x, point.y)
  await page.waitForFunction(`document.querySelector('#atelier-panel').hidden === false`, {
    timeout: 4000,
  })
  await page.close()
})

test('the open panel comes back too, not just the launcher', skip, async () => {
  const page = await pageWith(`<button id="go">Generate</button><dialog id="sheet">Settings</dialog>`)
  await page.evaluate(`document.querySelector('#sheet').showModal()`)
  const point = (await page.evaluate(`(() => {
    const r = document.querySelector('#atelier-panel').getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 10) }
  })()`)) as any
  await reachFor(page, point)
  await page.waitForFunction(
    `(() => { const h = document.elementFromPoint(${point.x}, ${point.y}); return !!h && !!h.closest('#atelier-root') })()`,
    { timeout: 4000 },
  )
  await page.close()
})

test('re-entering the top layer does not take the caret out of what is being typed', skip, async () => {
  // Leaving the top layer and going back into it runs the popover focus fixup,
  // which hands focus back to whatever had it before — mid-sentence, if the
  // person is typing a prompt into the composer.
  const page = await pageWith(`<input id="p" placeholder="Prompt">`)
  await pointAt(page, '#p')
  await page.evaluate(`(() => {
    const area = document.querySelector('#atelier-root .at-area')
    area.focus()
    area.value = 'a rope bridge'
    area.setSelectionRange(4, 4)
  })()`)
  await page.evaluate(`document.querySelector('#atelier-root').__atelierRaise()`)
  const state = (await page.evaluate(`(() => {
    const area = document.querySelector('#atelier-root .at-area')
    return { focused: document.activeElement === area, at: area.selectionStart }
  })()`)) as any
  assert.equal(state.focused, true, 'still typing into the same field')
  assert.equal(state.at, 4, 'and at the same place in it')
  await page.close()
})

/* --------------------------------------------------- one name, one value */

/**
 * Two fields cannot ask the agent for the same thing.
 *
 * The caller passes one value per name, so two dynamic fields sharing a name
 * would both receive it — which is silently not what anybody who drew two
 * boxes meant. The comparison is on what the name *becomes*: "Same text",
 * "SAME Text" and "same_text" are one name.
 */

/** Add a typed step the agent supplies, named by what the field is called. */
async function addDynamic(page: any, selector: string, name: string) {
  await pointAt(page, selector)
  await page.evaluate(`(() => {
    const input = document.querySelector('#atelier-root .at-card .at-input')
    input.value = ${JSON.stringify(name)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const area = document.querySelector('#atelier-root .at-area')
    area.value = 'something'
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await page.click('#atelier-root [data-mode="dynamic"]')
  await page.waitForSelector('#atelier-root .at-sub-field')
  await page.click('#atelier-root [data-act="add"]')
}

test('a second field cannot ask for a name the first already asks for', skip, async () => {
  const page = await pageWith(`<input id="a" placeholder="A"><input id="b" placeholder="B">`)
  await addDynamic(page, '#a', 'Same text')
  await page.waitForFunction(`window.__steps().length === 1`)

  await addDynamic(page, '#b', 'SAME Text')
  await page.waitForSelector('#atelier-root .at-error')
  const said = await page.evaluate(`document.querySelector('#atelier-root .at-error').textContent`)
  assert.match(said as string, /already asks the agent for/i)
  assert.match(said as string, /same_text/)

  assert.equal(await page.evaluate(`window.__steps().length`), 1, 'the step was not kept')
  // And the action was never performed, so the page did not move on for a step
  // that is being refused.
  assert.equal(await page.evaluate(`document.querySelector('#b').value`), '')
  await page.close()
})

test('the underscored spelling is the same name too', skip, async () => {
  const page = await pageWith(`<input id="a" placeholder="A"><input id="b" placeholder="B">`)
  await addDynamic(page, '#a', 'Same text')
  await page.waitForFunction(`window.__steps().length === 1`)
  await addDynamic(page, '#b', 'same_text')
  await page.waitForSelector('#atelier-root .at-error')
  assert.equal(await page.evaluate(`window.__steps().length`), 1)
  await page.close()
})

test('a different name is fine, and so is the same words on a kept value', skip, async () => {
  const page = await pageWith(
    `<input id="a" placeholder="A"><input id="b" placeholder="B"><input id="c" placeholder="C">`,
  )
  await addDynamic(page, '#a', 'Prompt')
  await page.waitForFunction(`window.__steps().length === 1`)
  await addDynamic(page, '#b', 'Negative prompt')
  await page.waitForFunction(`window.__steps().length === 2`)

  // Static values are setup, not inputs — nothing asks for them, so there is
  // nothing for them to collide with.
  await pointAt(page, '#c')
  await page.evaluate(`(() => {
    const input = document.querySelector('#atelier-root .at-card .at-input')
    input.value = 'Prompt'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await page.click('#atelier-root [data-act="add"]')
  await page.waitForFunction(`window.__steps().length === 3`)
  await page.close()
})

test('a recorded value can be renamed onto a free name, but not onto a taken one', skip, async () => {
  const page = await pageWith(`<input id="a" placeholder="A"><input id="b" placeholder="B">`)
  await addDynamic(page, '#a', 'Prompt')
  await page.waitForFunction(`window.__steps().length === 1`)
  await addDynamic(page, '#b', 'Subject')
  await page.waitForFunction(`window.__steps().length === 2`)

  // By step rather than by position: the pipeline reads newest-first, and a step
  // whose editor is open shows no Change this value button at all.
  await page.click('#atelier-root .at-step [data-edit="1"]')
  await page.waitForSelector('#atelier-root .at-edit [data-role="edit-name"]')

  const rename = async (name: string) => {
    await page.evaluate(
      `document.querySelector('#atelier-root .at-edit [data-role="edit-name"]').value = ${JSON.stringify(name)}`,
    )
    await page.click('#atelier-root .at-edit [data-save-edit]')
  }

  await rename('PROMPT')
  await page.waitForSelector('#atelier-root .at-edit .at-error')
  assert.equal(await page.evaluate(`window.__steps()[1].inputName`), 'subject', 'unchanged')
  // Refused, and left open on the thing being refused, so the name can just be
  // corrected rather than found again.
  assert.equal(await page.evaluate(`!!document.querySelector('#atelier-root .at-edit')`), true)

  await rename('Main subject')
  await page.waitForFunction(`window.__steps()[1].inputName === 'main_subject'`)
  await page.close()
})
