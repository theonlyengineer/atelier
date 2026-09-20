/**
 * Captures what the human does, richly enough that the proposal pass has real
 * choices to make.
 *
 * Two design decisions carry this file.
 *
 * The first: every interaction records *many* selector candidates, not one. A
 * recorder that stores a single CSS path produces workflows that break the first
 * time a class hash changes.
 *
 * The second: a result can be pointed at before it exists. Capturing by clicking
 * the finished thing only works if you already have a finished thing, which
 * means it cannot record the wait that produced it — and the wait is most of
 * what makes a workflow work. So arming a capture over an empty region starts a
 * MutationObserver, and the selector is resolved from whatever turns up there.
 * That is the difference between recording half a workflow and all of it.
 */
;(() => {
  if (window.__atelierRecorder) return
  window.__atelierRecorder = true

  let active = false
  /** null | 'capture' | 'wait' — what the next click on the page means. */
  let picking = null
  /** 'workflow' records until you save; 'step' captures one action and stops. */
  let mode = 'workflow'
  let count = 0
  let observer = null
  let poller = null

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
   *  redeploy. The proposal pass orders them; replay falls back down the list,
   *  and reports which one it used so decay is visible. */
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
    // Deliberately not el.value. A field's current contents are not its name:
    // they change between runs, so a selector built on them is broken by
    // definition — and for a password field, writing the value into a selector
    // would leak the exact thing the recorder refuses to record.
    const name = (aria || (isTypeable(el) ? '' : el.textContent) || '').trim().slice(0, 60)
    if (role && name) push('role', `${role}:${name}`, 84)
    if (el.name) push('name', `[name="${esc(el.name)}"]`, 80)
    const ph = el.getAttribute('placeholder')
    push('placeholder', ph && `[placeholder="${esc(ph)}"]`, 76)
    if (name && ['BUTTON', 'A', 'LABEL'].includes(el.tagName)) push('text', name, 60)
    push('css', cssPath(el), 40)
    push('xpath', xPath(el), 30)
    return out
  }

  /** Where Enter inserts a line rather than doing something. */
  const takesNewlines = (el) => {
    const node = el?.nodeType === 3 ? el.parentElement : el
    if (!node) return false
    return (
      node instanceof HTMLTextAreaElement ||
      node.isContentEditable === true ||
      !!node.closest?.('textarea, [contenteditable="true"], [contenteditable=""]')
    )
  }

  /** Anything whose value is user content rather than identity. */
  const isTypeable = (el) =>
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable === true

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

  /**
   * What counts as "the result turned up".
   *
   * Deliberately narrow. A generating page mutates constantly — spinners,
   * progress text, skeletons — and treating any mutation as the result is how
   * you capture a loading placeholder and call the job done. An image with a
   * real source, a video, a canvas, or a substantial block of text are the
   * things people actually wait for.
   */
  function resultIn(root) {
    if (!root || root.nodeType !== 1) return null

    const media = [root, ...root.querySelectorAll('img, video, canvas')].find((el) => {
      if (el.tagName === 'IMG') {
        const src = el.currentSrc || el.getAttribute('src') || ''
        // A 1px tracking pixel or an inline spinner is not a result.
        return src && !src.startsWith('data:image/gif') && el.naturalWidth > 64
      }
      if (el.tagName === 'VIDEO') return !!el.currentSrc
      if (el.tagName === 'CANVAS') return el.width > 64 && el.height > 64
      return false
    })
    if (media) return media

    const block = [root, ...root.querySelectorAll('pre, code, article, p, td')].find(
      (el) => (el.textContent || '').trim().length > 40,
    )
    return block || null
  }

  /** Image, text, or a file to download — inferred from what actually appeared,
   *  so nobody has to answer a question about it. */
  function captureKind(el) {
    if (['IMG', 'VIDEO', 'CANVAS', 'SVG'].includes(el.tagName)) return { as: 'image', attribute: 'src' }
    if (el.tagName === 'A' && el.hasAttribute('download')) return { as: 'download', attribute: 'href' }
    return { as: 'text' }
  }

  function stopObserving() {
    observer?.disconnect()
    observer = null
    clearInterval(poller)
    poller = null
  }

  /**
   * Watch a region until the result arrives, then record the capture against
   * whatever turned up.
   *
   * This is the whole point of the file. At the moment you click Generate the
   * thing you are waiting for does not exist, so there is nothing to point at —
   * which is why every recording used to come back missing the one step that
   * mattered.
   */
  function watchForResult(container) {
    stopObserving()
    setStatus(`Watching for the result…`)

    const settle = (node, waited) => {
      stopObserving()
      record({
        kind: 'capture',
        element: describe(node),
        capture: captureKind(node),
        // Recorded so the proposal pass knows this was a real wait, and so a
        // human reading the workflow later can see it was.
        resolvedByObserver: waited,
      })
      flash(node, '#2d7d46')
      setStatus('')
      if (mode === 'step') finishStepMode()
    }

    // It may already be there — someone arming capture over a finished result
    // should not be left waiting for a mutation that never comes.
    const already = resultIn(container)
    if (already) return settle(already, false)

    const tryResolve = () => {
      const found = resultIn(container)
      if (found) settle(found, true)
    }

    observer = new MutationObserver(tryResolve)
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })

    // The backstop, and not an optional one. An <img> is inserted and decoded
    // asynchronously: the mutation fires while naturalWidth is still 0, and
    // nothing mutates again when the decode completes. Watching only for
    // mutations means the common case — an image arriving — is the case that
    // never resolves.
    poller = setInterval(tryResolve, 250)
  }

  /* ------------------------------------------------------------ capture */

  /**
   * Everything this script says to the service worker goes through here.
   *
   * Reloading the extension at chrome://extensions destroys the context this
   * script belongs to while the script itself keeps running in the page, with
   * its listeners attached and its bar on screen. From that moment every
   * `chrome.runtime` call throws "Extension context invalidated" — once per
   * click, forever, with the bar still promising a recording that no longer
   * exists.
   *
   * So a dead context is treated as an expected state rather than an error: the
   * bar comes down, which is the honest thing to show, and nothing throws.
   */
  function send(message, onReply) {
    // `chrome.runtime.id` goes undefined the moment the context is gone. It is
    // the only cheap synchronous way to ask.
    if (!chrome.runtime?.id) return teardown()
    try {
      const reply = chrome.runtime.sendMessage(message, (res) => {
        // Reading lastError is what marks it handled. Unread, Chrome logs
        // "Unchecked runtime.lastError" from a frame with no useful stack.
        if (chrome.runtime.lastError) return
        onReply?.(res)
      })
      // With a callback the return value is undefined; without one it is a
      // promise that rejects when nothing is listening.
      reply?.catch?.(() => {})
    } catch {
      // Thrown synchronously, which is what an invalidated context does.
      teardown()
    }
  }

  function record(action) {
    count += 1
    send({
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

    // Arming a capture or a wait means this click is a *pointer*, not an action
    // to replay. Swallow it so the page does not also act on it.
    if (picking) {
      // The bar sits over the top of the page, so it is the easiest thing in the
      // window to hit by accident while pointing at something behind it. A click
      // on our own furniture is not a choice about the page.
      if (event.target?.closest?.('#atelier-bar')) return
      event.preventDefault()
      event.stopPropagation()
      const target = event.target
      const armed = picking
      picking = null
      setPicking(null)

      if (armed === 'capture') {
        // Point at the container, not the pixel. Clicking "where the image will
        // be" usually lands on a wrapper, which is exactly the right thing to
        // observe.
        watchForResult(target.closest('figure, picture, main, section, article, div') || target)
      } else {
        record({
          kind: 'wait',
          element: describe(target),
          wait: { kind: event.altKey ? 'hidden' : 'visible' },
        })
        flash(target, '#8a6d1f')
        if (mode === 'step') finishStepMode()
      }
      return
    }

    const el = event.target.closest(
      'button, a, input, textarea, select, [role], [onclick], label, [contenteditable]',
    )
    if (!el || el.closest('#atelier-bar')) return

    record({ kind: 'click', element: describe(el) })
    flash(el, '#1f6feb')
    if (mode === 'step') finishStepMode()
  }

  const pendingInput = new WeakMap()

  function onInput(event) {
    if (!active || picking) return
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
          // A password is never written down. The proposal pass turns this into
          // a `manual` step that parks the job for the human.
          value: isSecret(el) ? null : readValue(el),
          secret: isSecret(el),
          contentEditable: el.isContentEditable === true,
        })
        flash(el, '#1f6feb')
        if (mode === 'step') finishStepMode()
      }, 600),
    )
  }

  function onKey(event) {
    if (!active || picking) return
    if (event.key === 'Escape' && picking) {
      picking = null
      setPicking(null)
      return
    }
    if (!['Enter', 'Tab', 'Escape'].includes(event.key)) return
    if (event.target?.closest?.('#atelier-bar')) return
    // Enter in something that takes multi-line text is a newline, not an action.
    // The typed value already contains it, so recording a step as well was both
    // wrong and the thing that split one field's typing into three steps: the
    // key landed between two bursts, and the merge only joins adjacent ones.
    //
    // A single-line input is the opposite case — there Enter submits, which is
    // exactly the step that makes the workflow go.
    if (event.key === 'Enter' && takesNewlines(event.target)) return
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

  let bar, countEl, statusEl

  function buildBar(name) {
    bar = document.createElement('div')
    bar.id = 'atelier-bar'
    if (mode === 'step') {
      bar.innerHTML = `
        <span class="atelier-dot"></span>
        <span class="atelier-name">Re-recording one step</span>
        <span class="atelier-status">Do that one action again</span>
        <button class="atelier-btn atelier-ghost" data-act="discard">Cancel</button>`
    } else {
      bar.innerHTML = `
        <span class="atelier-dot"></span>
        <span class="atelier-name">Recording “${name}”</span>
        <span class="atelier-count">0 actions</span>
        <span class="atelier-status"></span>
        <button class="atelier-btn" data-act="capture" title="Point at where the result will appear — it does not have to be there yet">Capture result</button>
        <button class="atelier-btn" data-act="wait" title="Point at something to wait for. Hold Alt to wait for it to disappear instead">Wait for…</button>
        <button class="atelier-btn atelier-ghost" data-act="undo" title="Remove the last thing recorded">Undo</button>
        <button class="atelier-btn atelier-save" data-act="save">Save recording</button>
        <button class="atelier-btn atelier-ghost" data-act="discard" title="Throw this recording away">Discard</button>`
    }
    document.documentElement.appendChild(bar)
    countEl = bar.querySelector('.atelier-count')
    statusEl = bar.querySelector('.atelier-status')

    bar.addEventListener('pointerdown', onBarDown)
    window.addEventListener('resize', onWindowResize)
    // A navigation rebuilds the bar, so where it was put is read back rather
    // than reset. Clamped on the way in: the window may be a different size.
    barPlace = readBarPlace()
    if (barPlace) clampBar()

    bar.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act
      if (!act) return
      e.preventDefault()
      e.stopPropagation()
      if (act === 'save') {
        stopObserving()
        openReview()
      } else if (act === 'discard') {
        stopObserving()
        send({ t: 'record.discardFromPage' })
        teardown()
      } else if (act === 'undo') {
        send({ t: 'record.undo' }, (res) => {
          if (typeof res?.count === 'number') {
            count = res.count
            setCount(count)
          }
        })
      } else if (act === 'capture' || act === 'wait') {
        picking = picking === act ? null : act
        setPicking(picking)
      }
    })
  }

  function setCount(n) {
    if (countEl) countEl.textContent = `${n} action${n === 1 ? '' : 's'}`
  }

  /* --------------------------------------------------------- moving it */

  /**
   * The bar can be dragged, and cannot be dragged away.
   *
   * It is positioned over a page it knows nothing about, so it will sometimes be
   * sitting on the one control the person needs. Moving it is the fix. Clamping
   * is what makes moving it safe: a fixed overlay dragged past an edge is not
   * scrolled back into view by anything, so it would simply be gone for the rest
   * of the recording, with no way to reach Save.
   */
  const BAR_EDGE = 8
  const BAR_PLACE_KEY = 'atelier:bar-position'

  /** Null until it has been moved, so an untouched bar stays centred by CSS and
   *  keeps following the window on its own. */
  let barPlace = null
  let dragging = null

  function readBarPlace() {
    try {
      const raw = sessionStorage.getItem(BAR_PLACE_KEY)
      const parsed = raw && JSON.parse(raw)
      return parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top) ? parsed : null
    } catch {
      // Storage throws outright in some privacy modes. A bar that will not
      // render is worse than one that forgets where it was put.
      return null
    }
  }

  /** Inline and !important, because the stylesheet's centring is !important too
   *  and has to be beaten by something. */
  function placeBar(left, top) {
    if (!bar) return
    barPlace = { left, top }
    bar.style.setProperty('left', `${left}px`, 'important')
    bar.style.setProperty('top', `${top}px`, 'important')
    bar.style.setProperty('right', 'auto', 'important')
    bar.style.setProperty('transform', 'none', 'important')
    try {
      sessionStorage.setItem(BAR_PLACE_KEY, JSON.stringify(barPlace))
    } catch {
      /* not worth failing a recording over */
    }
  }

  /** Put it back inside, whether it was dragged out or the window shrank. */
  function clampBar(left = barPlace?.left, top = barPlace?.top) {
    if (!bar || left == null || top == null) return
    const { width, height } = bar.getBoundingClientRect()
    const maxLeft = Math.max(BAR_EDGE, window.innerWidth - width - BAR_EDGE)
    const maxTop = Math.max(BAR_EDGE, window.innerHeight - height - BAR_EDGE)
    placeBar(
      Math.min(Math.max(left, BAR_EDGE), maxLeft),
      Math.min(Math.max(top, BAR_EDGE), maxTop),
    )
  }

  function onBarDown(event) {
    // A control is for pressing. Only the bar's own background is a handle.
    if (event.target?.closest?.('button')) return
    const { left, top } = bar.getBoundingClientRect()
    dragging = { dx: event.clientX - left, dy: event.clientY - top }
    bar.classList.add('atelier-dragging')
    event.preventDefault()
    window.addEventListener('pointermove', onBarMove, true)
    window.addEventListener('pointerup', onBarUp, true)
  }

  function onBarMove(event) {
    if (!dragging) return
    clampBar(event.clientX - dragging.dx, event.clientY - dragging.dy)
  }

  function onBarUp() {
    dragging = null
    bar?.classList.remove('atelier-dragging')
    window.removeEventListener('pointermove', onBarMove, true)
    window.removeEventListener('pointerup', onBarUp, true)
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text
  }

  function setPicking(which) {
    document.documentElement.classList.toggle('atelier-picking', !!which)
    for (const btn of bar?.querySelectorAll('[data-act="capture"], [data-act="wait"]') ?? []) {
      btn.classList.toggle('atelier-armed', btn.dataset.act === which)
    }
    setStatus(
      which === 'capture'
        ? 'Click where the result will appear'
        : which === 'wait'
          ? 'Click what to wait for'
          : '',
    )
  }

  /** One-action mode: capture, hand it back, and get out of the way. */
  function finishStepMode() {
    send({ t: 'record.stepDone' })
    teardown()
  }

  /* ------------------------------------------------------------ review */

  let review = null

  /** What a step will do, in the words of the person who did it. */
  function reviewLine(action) {
    const named = action.element?.label?.trim()
    const on = named ? `“${named.slice(0, 40)}”` : action.element?.tag || 'the page'
    switch (action.kind) {
      case 'navigate': return ['Open', action.value || 'the page']
      case 'click': return ['Click', on]
      case 'key': return ['Press', action.value]
      case 'wait': return [action.wait?.kind === 'hidden' ? 'Wait for' : 'Wait for', on]
      case 'capture': return ['Capture the ' + (action.capture?.as || 'result'), 'from ' + on]
      case 'type': return ['Type into', on]
      default: return [action.kind, on]
    }
  }

  /** `System instructions` → `system_instructions`, as the proposal pass will. */
  function inputName(label) {
    return (
      (label || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 24) || 'input'
    )
  }

  /**
   * The review, in the page.
   *
   * Save used to commit the recording on the spot, which meant the only way to
   * check what had been heard — and what each step would actually type — was to
   * open the extension afterwards. The recording was made here; so is the place
   * to read it back.
   */
  function openReview() {
    send({ t: 'record.list' }, (res) => {
      if (!res || res.error) return setStatus(res?.error || 'could not read the recording')
      renderReview(res.name, res.actions || [])
    })
  }

  function renderReview(name, actions) {
    review?.remove()
    review = document.createElement('div')
    review.id = 'atelier-review'

    const card = document.createElement('div')
    card.className = 'atelier-review-card'

    const head = document.createElement('div')
    head.className = 'atelier-review-head'
    head.innerHTML =
      '<h2>Review “' + name + '”</h2>' +
      '<p>This is what was heard, and what each step will do. Anything you typed becomes a ' +
      'value the agent fills in — tick <b>always this</b> to keep the text instead.</p>'
    card.append(head)

    const list = document.createElement('ol')
    list.className = 'atelier-review-list'
    actions.forEach((action, index) => {
      const li = document.createElement('li')
      li.dataset.step = String(index)

      const [verb, what] = reviewLine(action)
      const line = document.createElement('div')
      line.className = 'atelier-review-line'
      line.innerHTML = '<span class="atelier-verb">' + verb + '</span> <span>' + (what || '') + '</span>'
      li.append(line)

      if (action.kind === 'type' && !action.secret) {
        const kept = action.role === 'fixed'
        const value = document.createElement('div')
        value.className = 'atelier-review-value' + (kept ? ' is-kept' : '')
        // The point of the whole screen: the text that will be typed, or the
        // name of the value that will be asked for instead.
        value.textContent = kept
          ? action.value || ''
          : '{{' + inputName(action.element?.label) + '}}  ·  ' + (action.value || '')
        li.append(value)

        const toggle = document.createElement('label')
        toggle.className = 'atelier-review-toggle'
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.checked = kept
        box.onchange = () => {
          send({ t: 'record.role', index, role: box.checked ? 'fixed' : 'input' }, (res) => {
            if (res?.error) return setStatus(res.error)
            // Re-read rather than patch in place: the worker is the truth, and a
            // screen that guessed what it did would drift from it.
            openReview()
          })
        }
        const words = document.createElement('span')
        words.textContent = 'always this'
        toggle.append(box, words)
        li.append(toggle)
      } else if (action.secret) {
        const value = document.createElement('div')
        value.className = 'atelier-review-value is-secret'
        value.textContent = 'You will be asked to type this yourself — passwords are never recorded'
        li.append(value)
      }

      list.append(li)
    })
    card.append(list)

    const actionsRow = document.createElement('div')
    actionsRow.className = 'atelier-review-actions'
    actionsRow.innerHTML =
      '<button class="atelier-btn atelier-save" data-act="confirm">Save workflow</button>' +
      '<button class="atelier-btn" data-act="back">Keep recording</button>' +
      '<button class="atelier-btn atelier-ghost" data-act="drop">Discard</button>'
    card.append(actionsRow)

    actionsRow.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act
      if (!act) return
      e.preventDefault()
      e.stopPropagation()
      if (act === 'confirm') {
        send({ t: 'record.saveFromPage' })
        teardown()
      } else if (act === 'drop') {
        send({ t: 'record.discardFromPage' })
        teardown()
      } else {
        closeReview()
      }
    })

    review.append(card)
    // On documentElement, like the bar: a page's own stacking contexts cannot
    // then bury it.
    document.documentElement.appendChild(review)
  }

  function closeReview() {
    review?.remove()
    review = null
  }

  function onWindowResize() {
    clampBar()
  }

  function teardown() {
    closeReview()
    onBarUp()
    window.removeEventListener('resize', onWindowResize)
    active = false
    picking = null
    stopObserving()
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
      mode = msg.mode === 'step' ? 'step' : 'workflow'
      count = msg.count ?? 0
      buildBar(msg.draftName)
      setCount(count)
      document.addEventListener('click', onClick, true)
      document.addEventListener('input', onInput, true)
      document.addEventListener('keydown', onKey, true)
      // Only a fresh workflow recording opens with where it started. A
      // re-recorded step is being spliced into a workflow that already knows.
      if (mode === 'workflow' && count === 0) record({ kind: 'navigate', value: location.href })
      respond({ ok: true })
    } else if (msg.t === 'record.end') {
      teardown()
      respond({ ok: true })
    } else if (msg.t === 'record.count') {
      count = msg.count ?? count
      setCount(count)
      respond({ ok: true })
    } else {
      respond({ ok: false })
    }
    return true
  })
})()
