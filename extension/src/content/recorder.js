/**
 * Captures what the human does, richly enough that the review pass has real
 * choices to make.
 *
 * The design decision that matters: every interaction records *many* selector
 * candidates, not one. A recorder that stores a single CSS path produces
 * workflows that break the first time a class hash changes.
 */
;(() => {
  if (window.__atelierRecorder) return
  window.__atelierRecorder = true

  let active = false
  let capturing = false // "Capture output" armed: next click marks the artifact
  let count = 0

  /* ---------------------------------------------------------- selectors */

  const esc = (s) => (window.CSS?.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'))

  /** Generated-looking ids and classes are worse than useless — they change on
   *  every build and make a workflow look robust while being brittle. */
  const looksGenerated = (s) =>
    /^[a-z]*[-_]?[0-9a-f]{6,}$/i.test(s) || /^(css|sc|jsx|emotion)-/.test(s) || /\d{4,}/.test(s)

  function cssPath(el) {
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === node.tagName)
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
      }
      parts.unshift(part)
      if (node.id && !looksGenerated(node.id)) {
        parts.unshift(`#${esc(node.id)}`)
        break
      }
      node = parent
    }
    return parts.join(' > ')
  }

  function xPath(el) {
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && node !== document.body) {
      const parent = node.parentElement
      const sameTag = parent ? [...parent.children].filter((c) => c.tagName === node.tagName) : [node]
      parts.unshift(`${node.tagName.toLowerCase()}[${sameTag.indexOf(node) + 1}]`)
      node = parent
    }
    return `/html/body/${parts.join('/')}`
  }

  /** Every way we can name this element, scored by how well each survives a
   *  redeploy. The review pass picks; replay falls back down the list. */
  function selectorsFor(el) {
    const out = []
    const push = (strategy, value, score) => value && out.push({ strategy, value, score })

    for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa']) {
      const v = el.getAttribute(attr)
      push('testid', v && `[${attr}="${esc(v)}"]`, 98)
    }
    if (el.id && !looksGenerated(el.id)) push('id', `#${esc(el.id)}`, 92)
    const aria = el.getAttribute('aria-label')
    push('aria', aria && `[aria-label="${esc(aria)}"]`, 88)
    const role = el.getAttribute('role') || implicitRole(el)
    const name = (aria || el.textContent || el.value || '').trim().slice(0, 60)
    if (role && name) push('role', `${role}:${name}`, 84)
    if (el.name) push('name', `[name="${esc(el.name)}"]`, 80)
    const ph = el.getAttribute('placeholder')
    push('placeholder', ph && `[placeholder="${esc(ph)}"]`, 76)
    if (name && ['BUTTON', 'A', 'LABEL'].includes(el.tagName)) push('text', name, 60)
    push('css', cssPath(el), 40)
    push('xpath', xPath(el), 30)
    return out
  }

  function implicitRole(el) {
    if (el.tagName === 'BUTTON') return 'button'
    if (el.tagName === 'A' && el.href) return 'link'
    if (el.tagName === 'TEXTAREA') return 'textbox'
    if (el.tagName === 'INPUT') {
      const t = (el.type || 'text').toLowerCase()
      if (['button', 'submit', 'reset'].includes(t)) return 'button'
      if (t === 'checkbox') return 'checkbox'
      return 'textbox'
    }
    return null
  }

  function describe(el) {
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || null,
      label:
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        (el.textContent || '').trim().slice(0, 80) ||
        null,
      selectors: selectorsFor(el),
    }
  }

  /* ------------------------------------------------------------ capture */

  function record(action) {
    count += 1
    chrome.runtime.sendMessage({
      t: 'record.action',
      action: { ...action, at: Date.now(), url: location.href, origin: location.origin },
    })
    setCount(count)
  }

  const isSecret = (el) =>
    el.tagName === 'INPUT' && ['password', 'otp'].includes((el.type || '').toLowerCase())

  /**
   * Anything a human types into.
   *
   * contenteditable matters more than it looks: most rich-text editors use a
   * contenteditable div rather than a textarea. Ignoring it meant recording a
   * session on such an editor and capturing every click but not the text — a
   * workflow with its one indispensable step missing.
   */
  const isEditable = (el) =>
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el?.isContentEditable === true

  const readValue = (el) =>
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : el.innerText

  function onClick(event) {
    if (!active) return
    const el = event.target.closest(
      'button, a, input, textarea, select, [role], [onclick], label, [contenteditable]',
    )
    if (!el || el.closest('#atelier-bar')) return

    if (capturing) {
      event.preventDefault()
      event.stopPropagation()
      capturing = false
      setCapturing(false)
      // Prefer the actual <img>. Clicking "the picture" usually lands on a
      // wrapper div, and a div has no src — which produced a capture step that
      // could never succeed.
      const raw = event.target
      const img =
        (raw.tagName === 'IMG' && raw) ||
        raw.querySelector?.('img') ||
        raw.closest?.('figure, picture, [role="img"], div')?.querySelector?.('img') ||
        null
      const target = img || el
      record({
        kind: 'capture',
        element: describe(target),
        capture: { as: 'image', attribute: 'src' },
        foundImg: !!img,
      })
      flash(target, '#2d7d46')
      return
    }
    record({ kind: 'click', element: describe(el) })
    flash(el, '#1f6feb')
  }

  const pendingInput = new WeakMap()

  function onInput(event) {
    if (!active) return
    // A contenteditable fires input on the editable host or a descendant, so
    // walk up to the element that actually owns the text.
    let el = event.target
    if (el?.nodeType === 3) el = el.parentElement
    if (el && !isEditable(el)) el = el.closest?.('[contenteditable="true"], [contenteditable=""]') || el
    if (!isEditable(el)) return
    if (el.closest('#atelier-bar')) return
    clearTimeout(pendingInput.get(el))
    // Debounced: one step per field, not one per keystroke.
    pendingInput.set(
      el,
      setTimeout(() => {
        record({
          kind: 'type',
          element: describe(el),
          // A password is never written down. The review pass turns this into a
          // `manual` step that parks the job for the human.
          value: isSecret(el) ? null : readValue(el),
          secret: isSecret(el),
          contentEditable: el.isContentEditable === true,
        })
        flash(el, '#1f6feb')
      }, 600),
    )
  }

  function onKey(event) {
    if (!active || !['Enter', 'Tab', 'Escape'].includes(event.key)) return
    if (event.target?.closest?.('#atelier-bar')) return
    record({ kind: 'key', value: event.key })
  }

  function flash(el, colour) {
    const prev = el.style.outline
    el.style.outline = `2px solid ${colour}`
    setTimeout(() => {
      el.style.outline = prev
    }, 320)
  }

  /* --------------------------------------------------------------- bar */

  let bar, countEl, captureBtn

  function buildBar(name) {
    bar = document.createElement('div')
    bar.id = 'atelier-bar'
    bar.innerHTML = `
      <span class="atelier-dot"></span>
      <span class="atelier-name">Recording “${name}”</span>
      <span class="atelier-count">0 actions</span>
      <button class="atelier-btn" data-act="capture">Capture output</button>
      <button class="atelier-btn atelier-stop" data-act="stop">Stop</button>`
    document.documentElement.appendChild(bar)
    countEl = bar.querySelector('.atelier-count')
    captureBtn = bar.querySelector('[data-act="capture"]')

    bar.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act
      if (act === 'stop') {
        chrome.runtime.sendMessage({ t: 'record.stopFromPage' })
        teardown()
      } else if (act === 'capture') {
        capturing = !capturing
        setCapturing(capturing)
      }
    })
  }

  function setCount(n) {
    if (countEl) countEl.textContent = `${n} action${n === 1 ? '' : 's'}`
  }

  function setCapturing(on) {
    document.documentElement.classList.toggle('atelier-picking', on)
    if (captureBtn) {
      captureBtn.textContent = on ? 'Click the result…' : 'Capture output'
      captureBtn.classList.toggle('atelier-armed', on)
    }
  }

  function teardown() {
    active = false
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('input', onInput, true)
    document.removeEventListener('keydown', onKey, true)
    document.documentElement.classList.remove('atelier-picking')
    bar?.remove()
    bar = null
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.t === 'record.begin') {
      active = true
      count = 0
      buildBar(msg.draftName)
      document.addEventListener('click', onClick, true)
      document.addEventListener('input', onInput, true)
      document.addEventListener('keydown', onKey, true)
      record({ kind: 'navigate', value: location.href })
      respond({ ok: true })
    } else if (msg.t === 'record.end') {
      teardown()
      respond({ ok: true })
    }
    return true
  })
})()
