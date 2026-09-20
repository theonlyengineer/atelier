/**
 * The control panel: where a workflow is built, one stated step at a time.
 *
 * This file replaced a recorder that watched a person work and inferred a
 * workflow from what it saw. That approach had one unfixable problem — a trace
 * of clicks and keystrokes does not contain intent. Which value varies between
 * runs, which click was incidental, which pause was the page thinking and which
 * was the person: none of it is in the evidence, so all of it was guessed, and
 * the guesses were wrong often enough that every recording had to be corrected
 * afterwards.
 *
 * So nothing is watched now. The person points at an element, confirms what to
 * call it, chooses an action from the ones that element can actually take, and
 * says whether its value is theirs or the caller's. Three decisions, each made
 * at the moment the answer is obvious.
 *
 * Two consequences worth stating, because they are the design and not details:
 *
 * **Atelier performs every action, not the person.** Add step runs the step
 * through the same executor that will replay it later. A step that cannot be
 * performed is refused while somebody is still looking at the page, instead of
 * being discovered on the first run a week later.
 *
 * **A recorded step cannot be removed or re-actioned.** Only its value can
 * change. A step list you can edit in the middle stops describing anything that
 * was actually performed, and the whole value of this thing is that it does.
 * Start over is the escape hatch, and it is honest about what it costs.
 */
;(() => {
  if (window.__atelierPanel) return
  window.__atelierPanel = true

  /** Everything Atelier draws lives under this one root — which is also what
   *  lets the executor tell the page apart from our own furniture. */
  const ROOT_ID = 'atelier-root'

  let rec = null
  /** null, or the function to call with the element the next click lands on. */
  let picking = null
  /** The element the composer is currently about, and what we know about it. */
  let picked = null
  let root = null
  let open = false
  /** Which step's value is open for editing, by index. Null when none is. */
  let editing = null
  /** What went wrong in the open value editor, if anything. */
  let editError = ''

  /* ------------------------------------------------------------ messaging */

  /**
   * Everything this script says to the service worker goes through here.
   *
   * Reloading the extension at chrome://extensions destroys the context this
   * script belongs to while the script itself keeps running in the page, with
   * its listeners attached and its panel on screen. From that moment every
   * `chrome.runtime` call throws "Extension context invalidated" — once per
   * click, forever, with the panel still promising a recording that no longer
   * exists.
   *
   * So a dead context is treated as an expected state rather than an error: the
   * panel comes down, which is the honest thing to show, and nothing throws.
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

  /* ------------------------------------------------------------ selectors */

  const esc = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'))

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

  const isEditable = (el) =>
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el?.isContentEditable === true

  function implicitRole(el) {
    if (el.tagName === 'BUTTON') return 'button'
    if (el.tagName === 'A' && el.href) return 'link'
    if (el.tagName === 'TEXTAREA') return 'textbox'
    if (el.tagName === 'SELECT') return 'combobox'
    if (el.tagName === 'INPUT') {
      const t = (el.type || 'text').toLowerCase()
      if (['button', 'submit', 'reset'].includes(t)) return 'button'
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      return 'textbox'
    }
    return null
  }

  /** Every way we can name this element, scored by how well each survives a
   *  redeploy. Replay falls back down the list and reports which one it used,
   *  so decay is visible before it is breakage. */
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
    const name = (aria || (isEditable(el) ? '' : el.textContent) || '').trim().slice(0, 60)
    if (role && name) push('role', `${role}:${name}`, 84)
    if (el.name) push('name', `[name="${esc(el.name)}"]`, 80)
    const ph = el.getAttribute('placeholder')
    push('placeholder', ph && `[placeholder="${esc(ph)}"]`, 76)
    if (name && ['BUTTON', 'A', 'LABEL'].includes(el.tagName)) push('text', name, 60)
    push('css', cssPath(el), 40)
    push('xpath', xPath(el), 30)
    return out
  }

  /** The label a form control is given by a <label> pointing at it. */
  function labelText(el) {
    if (el.id) {
      const tag = document.querySelector(`label[for="${esc(el.id)}"]`)
      if (tag) return (tag.textContent || '').trim()
    }
    const wrapping = el.closest?.('label')
    return wrapping ? (wrapping.textContent || '').trim() : ''
  }

  /**
   * What to call this element, and how that name can also find it.
   *
   * The order is the one a person would use out loud. A button is its text. A
   * field is what it asks you for — its placeholder, then its label. Anything
   * else falls back to whatever it was given to be identified by.
   */
  function suggestIdentifier(el) {
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)
    const aria = (el.getAttribute('aria-label') || '').trim()
    const placeholder = (el.getAttribute('placeholder') || '').trim()
    const alt = (el.getAttribute('alt') || '').trim()
    const title = (el.getAttribute('title') || '').trim()
    const label = labelText(el).replace(/\s+/g, ' ').slice(0, 80)

    if (isEditable(el) || el.tagName === 'SELECT') {
      if (placeholder) return { value: placeholder, strategy: 'placeholder', how: 'its placeholder' }
      if (aria) return { value: aria, strategy: 'aria', how: 'its label' }
      if (label) return { value: label, strategy: 'label', how: 'the label beside it' }
      if (el.name) return { value: el.name, strategy: 'name', how: 'its form name' }
    }
    if (text && text.length <= 80) return { value: text, strategy: 'text', how: 'its text' }
    if (aria) return { value: aria, strategy: 'aria', how: 'its label' }
    if (alt) return { value: alt, strategy: 'alt', how: 'its alt text' }
    if (title) return { value: title, strategy: 'title', how: 'its title' }
    if (label) return { value: label, strategy: 'label', how: 'the label beside it' }
    if (placeholder) return { value: placeholder, strategy: 'placeholder', how: 'its placeholder' }
    if (el.id && !looksGenerated(el.id)) return { value: el.id, strategy: 'id', how: 'its id' }
    return { value: el.tagName.toLowerCase(), strategy: 'none', how: 'nothing but its position' }
  }

  /**
   * Turn a confirmed name into a selector candidate — or into nothing.
   *
   * This is where a name the person changed stops being load-bearing. If the
   * string they confirmed still finds the element they pointed at, it becomes
   * the step's best selector, which is what makes a workflow readable when it
   * breaks. If they renamed it to something the page has never heard of, it
   * stays the step's *name* and the lookup falls to the candidates harvested
   * from the element. Both are fine; silently keeping a selector that does not
   * resolve is not, because it would read as decay forever afterwards.
   */
  function identifierSelector(el, value, strategy) {
    const text = String(value ?? '').trim()
    if (!text) return null
    const candidate =
      strategy === 'placeholder'
        ? { strategy: 'placeholder', value: `[placeholder="${esc(text)}"]`, score: 96 }
        : strategy === 'aria'
          ? { strategy: 'aria', value: `[aria-label="${esc(text)}"]`, score: 96 }
          : strategy === 'name'
            ? { strategy: 'name', value: `[name="${esc(text)}"]`, score: 96 }
            : strategy === 'id'
              ? { strategy: 'id', value: `#${esc(text)}`, score: 96 }
              : { strategy: 'text', value: text, score: 96 }
    return resolvesTo(candidate, el) ? candidate : null
  }

  /** Does this candidate, on its own, find the element we mean? */
  function resolvesTo(candidate, el) {
    try {
      // Exactly this element, not merely something around it. A label that
      // wraps an input contains it, so a loose test would happily accept a name
      // that replay then resolves to the label — and typing into a label does
      // nothing at all. The harvested candidates cover the element either way;
      // what is at stake here is only whether the name leads the list.
      if (candidate.strategy === 'text') {
        const wanted = candidate.value.trim().toLowerCase()
        const nodes = [...document.querySelectorAll('button, a, [role="button"], label, span, div')]
        const hit = nodes.find((n) => !n.closest(`#${ROOT_ID}`) && n.textContent?.trim().toLowerCase() === wanted)
        return hit === el
      }
      const hit = document.querySelector(candidate.value)
      return hit === el
    } catch {
      return false
    }
  }

  /* --------------------------------------------------------- the element */

  const isSecret = (el) =>
    el.tagName === 'INPUT' && ['password', 'otp'].includes((el.type || '').toLowerCase())

  const MEDIA_TAGS = ['IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'PICTURE', 'FIGURE', 'SVG']

  /**
   * The control an element stands for, which is not always the element itself.
   *
   * Web components mirror their attributes onto the host and keep the real
   * control inside, so pointing at what looks like the text box very often
   * lands on a wrapper. Offering that wrapper nothing but Click would be the
   * same bug replay had, seen from the other end — and replay descends the same
   * way, so what the action list promises is what the step will do.
   *
   * One control inside is that control; several is ambiguous and the element
   * stands only for itself.
   */
  const CONTROLS = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'

  function controlOf(el) {
    if (!el) return null
    if (isEditable(el) || el.tagName === 'SELECT') return el
    const inside = [...(el.querySelectorAll?.(CONTROLS) || [])].filter(
      (n) => !n.disabled && !(n instanceof HTMLInputElement && n.type === 'hidden'),
    )
    return inside.length === 1 ? inside[0] : null
  }

  /** What this element is, in the terms the action list needs. */
  function inspect(el) {
    const tag = el.tagName
    // The affordances come from the control; the identity comes from what was
    // pointed at, because that is what the person will read on the step.
    const field = controlOf(el) ?? el
    const type = (field.getAttribute?.('type') || '').toLowerCase()
    const editable =
      isEditable(field) && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type)
    return {
      tag,
      type,
      editable,
      secret: isSecret(field),
      select: field.tagName === 'SELECT',
      checkable: field.tagName === 'INPUT' && ['checkbox', 'radio'].includes(type),
      button:
        tag === 'BUTTON' ||
        (tag === 'A' && !!el.href) ||
        el.getAttribute('role') === 'button' ||
        (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(type)),
      media: MEDIA_TAGS.includes(tag) || !!el.querySelector?.('img, video, audio, canvas'),
      download: tag === 'A' && el.hasAttribute('download'),
      hasText: !!(el.textContent || '').trim(),
      hasPlaceholder: !!(el.getAttribute('placeholder') || field.getAttribute?.('placeholder')),
      options:
        field.tagName === 'SELECT'
          ? [...field.options].map((o) => o.text.trim()).filter(Boolean)
          : [],
    }
  }

  /**
   * The actions an element can take.
   *
   * An element-specific list rather than one long menu, because most of a
   * generic action list is nonsense for any given element — "choose an option"
   * on a button, "tick" on a paragraph — and a menu mostly full of nonsense
   * teaches people to stop reading it.
   */
  const ACTIONS = [
    {
      id: 'click',
      label: 'Click it',
      kind: 'click',
      applies: (i) => !i.secret,
      weight: (i) => (i.button ? 0 : 20),
    },
    {
      id: 'type',
      label: 'Type text into it',
      kind: 'type',
      value: 'text',
      applies: (i) => i.editable && !i.secret,
      weight: () => 0,
    },
    {
      id: 'manual',
      label: 'Stop and let me type it myself',
      kind: 'manual',
      applies: (i) => i.secret,
      weight: () => 0,
      note: 'A password is never recorded. The run parks here and hands you the keyboard.',
    },
    {
      id: 'clear',
      label: 'Clear it',
      kind: 'type',
      fixedValue: '',
      applies: (i) => i.editable && !i.secret,
      weight: () => 6,
    },
    {
      id: 'select',
      label: 'Choose an option',
      kind: 'select',
      value: 'option',
      applies: (i) => i.select,
      weight: () => 0,
    },
    { id: 'check', label: 'Tick it', kind: 'check', applies: (i) => i.checkable, weight: () => 0 },
    { id: 'uncheck', label: 'Untick it', kind: 'uncheck', applies: (i) => i.checkable, weight: () => 1 },
    {
      id: 'key',
      label: 'Press a key in it',
      kind: 'key',
      value: 'key',
      applies: (i) => i.editable && !i.secret,
      weight: () => 7,
    },
    {
      id: 'capture_media',
      label: 'Capture the image or file it holds',
      kind: 'capture',
      capture: { as: 'image', from: 'auto' },
      applies: (i) => i.media || i.download || !i.button,
      weight: (i) => (i.media || i.download ? 0 : 30),
    },
    {
      id: 'capture_text',
      label: 'Capture its text',
      kind: 'capture',
      capture: { as: 'text', from: 'auto' },
      applies: (i) => i.hasText || i.editable || i.select,
      weight: (i) => (i.editable || i.button ? 10 : 1),
    },
    {
      id: 'capture_placeholder',
      label: 'Capture its placeholder',
      kind: 'capture',
      capture: { as: 'text', from: 'placeholder' },
      applies: (i) => i.hasPlaceholder,
      weight: () => 12,
    },
    {
      id: 'wait_visible',
      label: 'Wait until it appears',
      kind: 'wait',
      wait: { kind: 'visible' },
      applies: () => true,
      weight: () => 40,
    },
    {
      id: 'wait_hidden',
      label: 'Wait until it goes away',
      kind: 'wait',
      wait: { kind: 'hidden' },
      applies: () => true,
      weight: () => 41,
    },
    {
      id: 'scroll',
      label: 'Scroll to it',
      kind: 'scroll',
      applies: () => true,
      weight: () => 45,
    },
  ]

  /**
   * A password field offers exactly one action, and it is the one that refuses.
   *
   * Not a filter that happens to come out that way — an explicit stop. Capture
   * its text and capture its placeholder both applied on the way through, and
   * either would have written the secret into an asset by a route that has
   * nothing to do with the recorder carefully not storing the value.
   */
  const actionsFor = (info) =>
    info.secret
      ? ACTIONS.filter((a) => a.kind === 'manual')
      : ACTIONS.filter((a) => a.applies(info)).sort((a, b) => a.weight(info) - b.weight(info))

  const actionById = (id) => ACTIONS.find((a) => a.id === id)

  /* ----------------------------------------------------------- the panel */

  /* ------------------------------------------------------- the top layer */

  /**
   * Staying on top of a page we know nothing about.
   *
   * The naive answer — the largest z-index there is — stopped working the day
   * sites started using real modals. `showModal()` and the popover API paint in
   * the **top layer**, which is above every z-index; 2147483647 is the biggest
   * number CSS will take and it loses to the top layer every time. So the panel
   * went under any site sheet that used one, launcher and all.
   *
   * Chrome's rules, measured rather than assumed:
   *
   * - Popovers are ordered among themselves by when each entered the top layer,
   *   and leaving and re-entering moves you to the front.
   * - A modal dialog is painted above *every* popover, whatever the order. There
   *   is no way to get above one from outside it.
   * - A popover under a modal dialog is not inert — it takes clicks — it simply
   *   cannot be seen, which is the worse half of the problem.
   *
   * So there are two moves, and which one is needed is decided by looking:
   *
   * 1. **Be a popover.** That beats every ordinary overlay and every site
   *    popover, which is nearly all of them.
   * 2. **When a modal dialog is on top, move inside it.** A top-layer element
   *    paints its whole subtree, so a child of the site's own dialog is above
   *    the dialog — and still interactive, and still able to watch clicks on
   *    the only part of the page that is not inert, which is the part the
   *    person is recording against anyway.
   */
  const canTopLayer = () =>
    typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function'

  /** The site's modal we are currently living inside, if any. */
  let nestedIn = null

  /**
   * Re-enter the top layer, which is what "come back to the front" means there.
   *
   * Leaving runs the popover focus fixup, which hands focus to whatever had it
   * before. That would take the caret out of a prompt somebody is halfway
   * through typing, so where it was is put back.
   */
  function raise() {
    if (!root || !root.hasAttribute('popover')) return
    const focused = root.contains(document.activeElement) ? document.activeElement : null
    const at =
      focused && typeof focused.selectionStart === 'number'
        ? [focused.selectionStart, focused.selectionEnd]
        : null
    try {
      if (root.matches(':popover-open')) root.hidePopover()
      root.showPopover()
    } catch {
      // A popover that is not connected, or a browser that changed its mind
      // about the API. Either way the stylesheet still draws the panel.
      return
    }
    if (focused && document.activeElement !== focused) {
      try {
        focused.focus({ preventScroll: true })
        if (at) focused.setSelectionRange(at[0], at[1])
      } catch {
        /* not a field that carries a selection */
      }
    }
  }

  /**
   * Put our origin back on the viewport's origin, by measuring where it landed.
   *
   * Inside a host that establishes a containing block — a transform, a filter, a
   * `contain` — a fixed child is positioned against *that*, not the viewport, so
   * the panel would arrive offset by wherever the site's dialog happens to sit.
   * Measuring and correcting needs no list of the properties that cause it,
   * which is the point: that list grows, and a missing entry would be a bug
   * nobody could see except on the one site that used it.
   */
  function pinOrigin() {
    if (!root) return
    root.style.setProperty('left', '0px', 'important')
    root.style.setProperty('top', '0px', 'important')
    const box = root.getBoundingClientRect()
    if (box.left === 0 && box.top === 0) return
    root.style.setProperty('left', `${-box.left}px`, 'important')
    root.style.setProperty('top', `${-box.top}px`, 'important')
  }

  /** Move in with the site's modal, because there is no way above one. */
  function nestInto(host) {
    if (nestedIn === host) return
    comeHome()
    // A popover inside a modal is still painted below it, so being one here
    // would undo the whole move.
    try {
      if (root.matches(':popover-open')) root.hidePopover()
    } catch {
      /* was not showing */
    }
    root.removeAttribute('popover')
    host.appendChild(root)
    nestedIn = host
    host.addEventListener('close', comeHome, { once: true })
    pinOrigin()
  }

  /** Back to our own place, whenever the host closes or goes away. */
  function comeHome() {
    if (!root) return
    if (nestedIn) {
      nestedIn.removeEventListener('close', comeHome)
      nestedIn = null
    }
    if (root.parentNode !== document.documentElement) document.documentElement.appendChild(root)
    if (canTopLayer() && !root.hasAttribute('popover')) root.setAttribute('popover', 'manual')
    raise()
    pinOrigin()
  }

  /**
   * What is painted over us, if anything.
   *
   * One hit test at the point a person would aim at. Cheaper and more honest
   * than watching for a site opening a dialog: there is no event for entering
   * the top layer, and the question that matters is not "did something open"
   * but "is the thing I am about to click actually reachable".
   */
  function covering() {
    const anchor = open ? $('atelier-panel') : $('atelier-launcher')
    if (!anchor) return null
    const box = anchor.getBoundingClientRect()
    if (!box.width || !box.height) return null
    const x = Math.min(Math.max(box.left + box.width / 2, 1), window.innerWidth - 1)
    // The top of the panel rather than its middle: the middle is a step box or
    // a textarea, and the header is the part that is there whatever it shows.
    const y = Math.min(
      Math.max(open ? box.top + 10 : box.top + box.height / 2, 1),
      window.innerHeight - 1,
    )
    const hit = document.elementFromPoint(x, y)
    return hit && !root.contains(hit) && hit !== root ? hit : null
  }

  /** The whole decision, in one place, run whenever it might have changed. */
  function keepOnTop() {
    if (!root) return
    // The host was torn out of the document and took us with it.
    if (!root.isConnected) comeHome()
    if (nestedIn && (!nestedIn.isConnected || !nestedIn.matches('dialog:modal'))) comeHome()

    const over = covering()
    if (!over) return
    const modal = over.closest?.('dialog:modal') ?? null
    if (modal) nestInto(modal)
    else {
      if (nestedIn) comeHome()
      raise()
    }
  }

  /**
   * How often the check above is allowed to run, in milliseconds.
   *
   * `checkedAt` is a wall-clock stamp and starts at zero, which is 1970 — so the
   * first check after a page loads always runs. It used to take the timestamp
   * off the event instead, which counts from when the page loaded, and zero then
   * meant "checked at load": every check in the first quarter second of a page's
   * life was suppressed, including the only two a test ever made.
   */
  const CHECK_EVERY = 250
  let checkedAt = 0

  /**
   * The mouse moving is the signal that somebody is about to reach for the
   * panel, which makes this self-healing before the first click rather than
   * after it. Throttled, and it does nothing at all while the panel has focus —
   * if you are typing into it, it is plainly reachable.
   */
  function onPointerMove() {
    if (!root) return
    const now = Date.now()
    if (now - checkedAt < CHECK_EVERY) return
    checkedAt = now
    if (root.contains(document.activeElement)) return
    keepOnTop()
  }

  /** Anything worth clicking is worth being on top for first. */
  function onPointerDown(event) {
    if (!root || event.target?.closest?.(`#${ROOT_ID}`)) return
    keepOnTop()
  }

  function build() {
    root = document.createElement('div')
    root.id = ROOT_ID
    // `manual` rather than `auto`: an auto popover light-dismisses on any click
    // outside it, which is every click of a recording.
    if (canTopLayer()) root.setAttribute('popover', 'manual')
    root.innerHTML = `
      <button id="atelier-launcher" type="button" title="Atelier — recording">
        <span class="at-glyph">A</span><span class="at-pip"></span>
      </button>

      <section id="atelier-panel" hidden>
        <header class="at-head">
          <span class="at-glyph at-glyph-sm">A</span>
          <div class="at-heading">
            <b id="at-name">Untitled</b>
            <span id="at-sub"></span>
          </div>
          <button class="at-icon" data-act="collapse" type="button" title="Minimise">&minus;</button>
        </header>

        <div class="at-body">
          <div id="at-compose" class="at-compose"></div>
          <ol id="at-steps" class="at-steps"></ol>
        </div>

        <footer class="at-foot">
          <button class="at-btn at-primary" data-act="save" type="button">Save workflow</button>
          <button class="at-btn" data-act="restart" type="button">Start over</button>
          <button class="at-btn at-ghost" data-act="discard" type="button">Discard</button>
        </footer>
      </section>

      <div id="at-hint" class="at-hint" hidden></div>
      <div id="at-modal" class="at-modal" hidden><div class="at-modal-card"></div></div>`
    // On documentElement, like everything else we draw: a page's own stacking
    // contexts cannot then bury it.
    document.documentElement.appendChild(root)
    raise()
    pinOrigin()

    // The test harness drives these directly; there is no event for "something
    // entered the top layer" to wait on instead.
    root.__atelierRaise = raise
    root.__atelierKeepOnTop = keepOnTop

    $('atelier-launcher').addEventListener('pointerdown', onLauncherDown)
    $('atelier-launcher').addEventListener('click', onLauncherClick)
    window.addEventListener('resize', clampLauncher)
    root.addEventListener('click', onPanelClick)
    root.addEventListener('change', onPanelChange)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
    // Free, and covers the case where the pointer never moves — a keyboard
    // user, or a sheet that opens under a stationary cursor.
    document.addEventListener('pointerdown', onPointerDown, true)

    place = readPlace()
    clampLauncher()
  }

  const $ = (id) => root?.querySelector(`#${id}`)

  /* ------------------------------------------------- moving the launcher */

  /**
   * The launcher can be dragged, and cannot be dragged away.
   *
   * It is positioned over a page it knows nothing about, so it will sometimes
   * sit on the one control the person needs. Moving it is the fix. Clamping is
   * what makes moving it safe: a fixed overlay dragged past an edge is not
   * scrolled back into view by anything, so it would simply be gone for the
   * rest of the recording, and Save with it.
   */
  const EDGE = 12
  const PLACE_KEY = 'atelier:launcher-position'
  let place = null
  let dragging = null
  let dragged = false

  function readPlace() {
    try {
      const raw = sessionStorage.getItem(PLACE_KEY)
      const parsed = raw && JSON.parse(raw)
      return parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top) ? parsed : null
    } catch {
      // Storage throws outright in some privacy modes. A panel that will not
      // render is worse than one that forgets where it was put.
      return null
    }
  }

  function placeLauncher(left, top) {
    const el = $('atelier-launcher')
    if (!el) return
    place = { left, top }
    el.style.setProperty('left', `${left}px`, 'important')
    el.style.setProperty('top', `${top}px`, 'important')
    el.style.setProperty('right', 'auto', 'important')
    el.style.setProperty('bottom', 'auto', 'important')
    try {
      sessionStorage.setItem(PLACE_KEY, JSON.stringify(place))
    } catch {
      /* not worth failing a recording over */
    }
  }

  function clampLauncher(left = place?.left, top = place?.top) {
    const el = $('atelier-launcher')
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    if (left == null || top == null) return
    const maxLeft = Math.max(EDGE, window.innerWidth - width - EDGE)
    const maxTop = Math.max(EDGE, window.innerHeight - height - EDGE)
    placeLauncher(
      Math.min(Math.max(left, EDGE), maxLeft),
      Math.min(Math.max(top, EDGE), maxTop),
    )
  }

  function onLauncherDown(event) {
    const { left, top } = $('atelier-launcher').getBoundingClientRect()
    dragging = { dx: event.clientX - left, dy: event.clientY - top, x: event.clientX, y: event.clientY }
    dragged = false
    event.preventDefault()
    window.addEventListener('pointermove', onLauncherMove, true)
    window.addEventListener('pointerup', onLauncherUp, true)
  }

  function onLauncherMove(event) {
    if (!dragging) return
    // A few pixels of travel is a click with a shaky hand, not a drag — and
    // treating one as a drag means the launcher sometimes refuses to open.
    if (Math.abs(event.clientX - dragging.x) + Math.abs(event.clientY - dragging.y) > 4) dragged = true
    clampLauncher(event.clientX - dragging.dx, event.clientY - dragging.dy)
  }

  function onLauncherUp() {
    dragging = null
    window.removeEventListener('pointermove', onLauncherMove, true)
    window.removeEventListener('pointerup', onLauncherUp, true)
  }

  function onLauncherClick(event) {
    event.preventDefault()
    event.stopPropagation()
    // Dropping the launcher where you wanted it should not also open the panel.
    if (dragged) {
      dragged = false
      return
    }
    setOpen(!open)
  }

  function setOpen(next) {
    open = next
    const panel = $('atelier-panel')
    if (panel) panel.hidden = !open
    root?.classList.toggle('at-open', open)
    // The panel is far bigger than the launcher, so it can be buried by
    // something the launcher was clear of.
    if (open) keepOnTop()
  }

  /* ------------------------------------------------------------- picking */

  /**
   * Arm the picker, and get out of the way.
   *
   * The panel is deliberately hidden while pointing: it is the biggest thing on
   * screen and the element you want is very often behind it. A thin line of
   * text says what the next click means, because a cursor change alone is not
   * enough to tell somebody they are in a mode.
   */
  function pick(prompt, onPicked) {
    picking = onPicked
    setOpen(false)
    document.documentElement.classList.add('at-picking')
    const hint = $('at-hint')
    hint.textContent = `${prompt} — press Esc to cancel`
    hint.hidden = false
  }

  function stopPicking() {
    picking = null
    document.documentElement.classList.remove('at-picking')
    const hint = $('at-hint')
    if (hint) hint.hidden = true
  }

  function onCapturePhaseClick(event) {
    if (!picking) return
    // Our own furniture is not a choice about the page.
    if (event.target?.closest?.(`#${ROOT_ID}`)) return
    event.preventDefault()
    event.stopPropagation()
    const target = event.target
    const chosen = picking
    stopPicking()
    setOpen(true)
    chosen(target)
  }

  function flash(el, colour) {
    if (!el?.style) return
    const previous = el.style.outline
    el.style.outline = `2px solid ${colour}`
    setTimeout(() => {
      el.style.outline = previous
    }, 420)
  }

  /* ----------------------------------------------------------- composing */

  function beginPick() {
    pick('Click the element this step is about', (el) => {
      const suggestion = suggestIdentifier(el)
      picked = {
        el,
        info: inspect(el),
        identifier: suggestion.value,
        strategy: suggestion.strategy,
        how: suggestion.how,
        action: null,
        value: '',
        valueMode: 'static',
        inputName: '',
        error: '',
      }
      const available = actionsFor(picked.info)
      picked.action = available[0]?.id ?? 'click'
      // Seed the value from what the field already holds, minus anything we
      // refuse to record. Most of the time it is what they want to type again —
      // and it comes from the control rather than the wrapper, which mirrors
      // the placeholder but never the text.
      if (!picked.info.secret && picked.info.editable) {
        const field = controlOf(el) ?? el
        picked.value = field.value ?? field.innerText ?? ''
      }
      flash(el, '#ff6552')
      renderCompose()
    })
  }

  function renderCompose() {
    const host = $('at-compose')
    if (!host) return
    host.replaceChildren()

    if (rec?.mode === 'repoint') return renderRepointCompose(host)

    if (!picked) {
      const empty = el('div', 'at-idle')
      empty.append(
        button('at-btn at-primary at-wide', 'Point at an element', { act: 'pick' }),
        el(
          'p',
          'at-note',
          rec?.steps?.length
            ? 'Add the next step. Atelier performs each one as you add it, so the page is where it would be on a real run.'
            : 'Point at what the first step is about. Atelier will do the clicking — you only say what to act on and how.',
        ),
      )
      host.append(empty)
      return
    }

    const card = el('div', 'at-card')

    /* --- what it is ---------------------------------------------------- */
    const targetField = el('label', 'at-field')
    targetField.append(el('span', 'at-label', 'Target'))
    const nameInput = document.createElement('input')
    nameInput.className = 'at-input'
    nameInput.value = picked.identifier
    nameInput.spellcheck = false
    nameInput.addEventListener('input', () => {
      picked.identifier = nameInput.value
    })
    targetField.append(nameInput)
    targetField.append(
      el('span', 'at-note', `Suggested from ${picked.how}. This is what the step will be called.`),
    )
    card.append(targetField)

    /* --- what to do with it -------------------------------------------- */
    const available = actionsFor(picked.info)
    const actionField = el('label', 'at-field')
    actionField.append(el('span', 'at-label', 'Action'))
    const select = document.createElement('select')
    select.className = 'at-input'
    select.dataset.role = 'action'
    for (const action of available) {
      const option = document.createElement('option')
      option.value = action.id
      option.textContent = action.label
      if (action.id === picked.action) option.selected = true
      select.append(option)
    }
    actionField.append(select)
    const chosen = actionById(picked.action)
    if (chosen?.note) actionField.append(el('span', 'at-note', chosen.note))
    card.append(actionField)

    /* --- and with what value ------------------------------------------- */
    if (chosen?.value === 'text') card.append(valueField())
    if (chosen?.value === 'option') card.append(optionField())
    if (chosen?.value === 'key') card.append(keyField())

    if (picked.error) card.append(el('p', 'at-error', picked.error))

    const actions = el('div', 'at-actions')
    actions.append(
      button('at-btn at-primary', 'Add step', { act: 'add' }),
      button('at-btn at-ghost', 'Cancel', { act: 'cancel' }),
    )
    card.append(actions)
    host.append(card)
  }

  function valueField() {
    const field = el('div', 'at-field')
    field.append(el('span', 'at-label', 'Text to type'))

    const area = document.createElement('textarea')
    area.className = 'at-input at-area'
    area.value = picked.value ?? ''
    area.rows = 3
    area.addEventListener('input', () => {
      picked.value = area.value
    })
    field.append(area)

    /**
     * Static or dynamic, said plainly.
     *
     * The words matter more than the control. "Static" and "dynamic" describe
     * the implementation; what a person is deciding is whether they are typing
     * this once or every time. A static value is never shown to the agent at
     * all — it does not appear in the workflow's inputs and nothing reports it,
     * which is the point of marking it.
     */
    const seg = el('div', 'at-seg')
    seg.append(
      segButton('static', 'Always this', picked.valueMode === 'static'),
      segButton('dynamic', 'The agent supplies it', picked.valueMode === 'dynamic'),
    )
    field.append(seg)

    if (picked.valueMode === 'dynamic') {
      const nameField = el('div', 'at-field at-sub-field')
      nameField.append(el('span', 'at-label', 'The agent passes it as'))
      const input = document.createElement('input')
      input.className = 'at-input'
      input.value = picked.inputName || slug(picked.identifier)
      input.addEventListener('input', () => {
        picked.inputName = input.value
      })
      nameField.append(input)
      nameField.append(
        el('span', 'at-note', 'The text above is kept too, and is what a test run types.'),
      )
      field.append(nameField)
    } else {
      field.append(el('span', 'at-note', 'Replayed exactly. The agent never sees this text.'))
    }
    return field
  }

  function optionField() {
    const field = el('div', 'at-field')
    field.append(el('span', 'at-label', 'Option'))
    const select = document.createElement('select')
    select.className = 'at-input'
    select.dataset.role = 'option'
    for (const option of picked.info.options) {
      const node = document.createElement('option')
      node.value = option
      node.textContent = option
      if (option === picked.value) node.selected = true
      select.append(node)
    }
    if (!picked.value) picked.value = picked.info.options[0] ?? ''
    field.append(select)
    return field
  }

  function keyField() {
    const field = el('div', 'at-field')
    field.append(el('span', 'at-label', 'Key'))
    const select = document.createElement('select')
    select.className = 'at-input'
    select.dataset.role = 'key'
    for (const key of ['Enter', 'Tab', 'Escape']) {
      const node = document.createElement('option')
      node.value = key
      node.textContent = key
      if (key === picked.value) node.selected = true
      select.append(node)
    }
    if (!['Enter', 'Tab', 'Escape'].includes(picked.value)) picked.value = 'Enter'
    field.append(select)
    return field
  }

  function renderRepointCompose(host) {
    const card = el('div', 'at-card')
    card.append(
      el('p', 'at-note', `Point at the element this step should use now: ${rec.stepNote || rec.stepId}`),
      el(
        'p',
        'at-note',
        'Only where the step looks changes. What it does was decided when the workflow was made and stands.',
      ),
    )
    if (!picked) {
      card.append(button('at-btn at-primary at-wide', 'Point at the element', { act: 'pick' }))
      host.append(card)
      return
    }
    const field = el('label', 'at-field')
    field.append(el('span', 'at-label', 'Target'))
    const input = document.createElement('input')
    input.className = 'at-input'
    input.value = picked.identifier
    input.addEventListener('input', () => {
      picked.identifier = input.value
    })
    field.append(input)
    card.append(field)
    const actions = el('div', 'at-actions')
    actions.append(
      button('at-btn at-primary', 'Use this element', { act: 'repoint' }),
      button('at-btn at-ghost', 'Cancel', { act: 'cancel' }),
    )
    card.append(actions)
    host.append(card)
  }

  /* --------------------------------------------------------- adding one */

  /** The step as it will be saved, and as it is about to be performed. */
  function composeStep() {
    const action = actionById(picked.action)
    const identifier = identifierSelector(picked.el, picked.identifier, picked.strategy)
    const step = {
      kind: action.kind,
      target: String(picked.identifier ?? '').trim() || picked.info.tag.toLowerCase(),
      identifier,
      selectors: selectorsFor(picked.el),
      origin: location.origin,
    }
    if (action.capture) step.capture = { ...action.capture }
    if (action.wait) step.wait = { ...action.wait }
    if (action.kind === 'manual') step.secret = true
    if (action.id === 'clear') {
      step.valueMode = 'static'
      step.sampleValue = ''
      step.value = ''
    } else if (action.value) {
      const sample = String(picked.value ?? '')
      step.valueMode = action.kind === 'key' ? 'static' : picked.valueMode
      step.sampleValue = sample
      step.value = sample
      if (step.valueMode === 'dynamic') {
        step.inputName = slug(picked.inputName || picked.identifier)
      }
    }
    return step
  }

  /**
   * Perform the step, then keep it.
   *
   * In that order, and the order is the feature. The executor that runs this is
   * the one that will replay it, so a step that cannot be performed now is one
   * that would have failed on the first run — and it is refused here, while the
   * person is still looking at the page and can point at something else.
   */
  function addStep() {
    const action = actionById(picked.action)
    if (action.value === 'text' && picked.valueMode === 'dynamic') {
      const name = slug(picked.inputName || picked.identifier)
      if (!name) {
        picked.error = 'Give the value a name the agent can pass it under.'
        return renderCompose()
      }
      // Checked here, before the action is performed, and again in the worker.
      // Here because performing it would move the page on for a step that is
      // then refused; there because the worker owns the recording and a stale
      // panel must not be able to slip one past it.
      const at = clashAt(name)
      if (at !== -1) {
        picked.error = clashWords(at)
        return renderCompose()
      }
    }

    const step = composeStep()
    picked.error = ''
    setBusy(true)

    // A manual step cannot be performed by definition — it exists to stop and
    // hand the keyboard over — so it is added without being run.
    if (step.kind === 'manual') return keep(step)

    // Short and fixed, because the element was picked a second ago and is right
    // there. The generous per-step timeouts are for replay, when nobody is.
    const trial = { ...step, timeoutMs: 4000 }
    perform(trial, (result) => {
      if (!result?.ok) {
        setBusy(false)
        picked.error =
          (result?.reason || 'the step could not be performed') +
          ' — point at a different element, or choose another action.'
        return renderCompose()
      }
      keep(step)
    })
  }

  function keep(step) {
    send({ t: 'record.addStep', step }, (res) => {
      setBusy(false)
      if (res?.error) {
        picked.error = res.error
        return renderCompose()
      }
      picked = null
      refresh()
    })
  }

  function perform(step, done) {
    try {
      const result = window.__atelierReplay?.(step)
      if (!result) return done({ ok: false, reason: 'the step executor is not loaded — reload the page' })
      Promise.resolve(result).then(done, (e) => done({ ok: false, reason: String(e?.message || e) }))
    } catch (e) {
      done({ ok: false, reason: String(e?.message || e) })
    }
  }

  function setBusy(on) {
    root?.classList.toggle('at-busy', !!on)
  }

  /* -------------------------------------------------------- the pipeline */

  const ACTION_WORDS = {
    click: 'Click it',
    type: 'Type text into it',
    select: 'Choose an option',
    check: 'Tick it',
    uncheck: 'Untick it',
    key: 'Press a key',
    scroll: 'Scroll to it',
    manual: 'Stop and hand over the keyboard',
  }

  function describeAction(step) {
    if (step.kind === 'capture') {
      return step.capture?.from === 'placeholder'
        ? 'Capture its placeholder'
        : step.capture?.as === 'text'
          ? 'Capture its text'
          : 'Capture the image or file it holds'
    }
    if (step.kind === 'wait') {
      return step.wait?.kind === 'hidden' ? 'Wait until it goes away' : 'Wait until it appears'
    }
    if (step.kind === 'type' && step.sampleValue === '' && step.valueMode === 'static') return 'Clear it'
    return ACTION_WORDS[step.kind] ?? step.kind
  }

  /**
   * The steps, read bottom to top.
   *
   * The first step is at the bottom and each new one appears at the top,
   * directly under the composer that just made it — so the thing you added a
   * moment ago is the thing in front of you, and the sequence still reads as
   * one line from where it started to where it is now.
   */
  function renderSteps() {
    const host = $('at-steps')
    if (!host) return
    const steps = rec?.steps ?? []
    host.replaceChildren()
    host.classList.toggle('at-has-steps', steps.length > 0)

    if (!steps.length) {
      host.append(el('li', 'at-empty', 'No steps yet. The first one you add appears here.'))
      return
    }

    // Newest first in the document, so step one sits at the bottom.
    for (let index = steps.length - 1; index >= 0; index--) {
      host.append(stepNode(steps[index], index))
    }
  }

  function stepNode(step, index) {
    const li = el('li', 'at-step')
    li.dataset.index = String(index)
    li.append(el('span', 'at-node', String(index + 1)))

    const box = el('div', 'at-box')
    box.append(row('Target', step.target || '—'))
    box.append(row('Action', describeAction(step)))

    if (step.secret) {
      box.append(el('p', 'at-value is-secret', 'You will type this yourself — passwords are never recorded'))
    } else if (step.kind === 'type' || step.kind === 'select') {
      if (editing === index) box.append(valueEditor(step, index))
      else {
        const dynamic = step.valueMode === 'dynamic'
        const value = el(
          'p',
          `at-value${dynamic ? ' is-dynamic' : ''}`,
          dynamic
            ? `{{${step.inputName || slug(step.target)}}} — the agent supplies it. A test run types: ${step.sampleValue || '(nothing)'}`
            : step.sampleValue === ''
              ? '(empties the field)'
              : step.sampleValue ?? '',
        )
        box.append(value)
        box.append(button('at-link', 'Change this value', { edit: String(index) }))
      }
    }

    li.append(box)
    return li
  }

  function valueEditor(step, index) {
    const wrap = el('div', 'at-edit')
    const mode = step.valueMode === 'dynamic' ? 'dynamic' : 'static'

    const seg = el('div', 'at-seg')
    seg.append(
      segButton('static', 'Always this', mode === 'static', index),
      segButton('dynamic', 'The agent supplies it', mode === 'dynamic', index),
    )
    wrap.append(seg)

    const area = document.createElement('textarea')
    area.className = 'at-input at-area'
    area.dataset.role = 'edit-value'
    area.rows = 3
    area.value = step.sampleValue ?? ''
    wrap.append(area)

    if (mode === 'dynamic') {
      const input = document.createElement('input')
      input.className = 'at-input'
      input.dataset.role = 'edit-name'
      input.value = step.inputName || slug(step.target)
      wrap.append(el('span', 'at-label', 'The agent passes it as'), input)
    }

    if (editError) wrap.append(el('p', 'at-error', editError))

    const actions = el('div', 'at-actions')
    actions.append(
      button('at-btn at-primary', 'Save', { saveEdit: String(index) }),
      button('at-btn at-ghost', 'Cancel', { cancelEdit: '1' }),
    )
    wrap.append(actions)
    return wrap
  }

  /* -------------------------------------------------------------- render */

  function render() {
    if (!root) return
    const steps = rec?.steps ?? []
    $('at-name').textContent = rec?.name || 'Untitled workflow'
    $('at-sub').textContent =
      rec?.mode === 'repoint'
        ? 'Repointing one step'
        : `${steps.length} step${steps.length === 1 ? '' : 's'} · ${(rec?.origins ?? []).join(', ')}`
    root.classList.toggle('at-repoint', rec?.mode === 'repoint')
    $('atelier-panel').querySelector('.at-foot').hidden = rec?.mode === 'repoint'
    renderCompose()
    renderSteps()
  }

  function refresh() {
    send({ t: 'record.state' }, (res) => {
      if (res?.recording) {
        rec = res.recording
        render()
      } else if (res && !res.recording) {
        teardown()
      }
    })
  }

  /* ------------------------------------------------------------ dialogs */

  /**
   * Atelier's own dialogs, not the browser's.
   *
   * `window.prompt` and `window.confirm` are modal to the whole tab: they stop
   * the page, they cannot be styled, and on a page that is mid-render they can
   * simply not appear. They are also the one thing in this system that looks
   * like it belongs to the site rather than to Atelier, at the exact moment the
   * question is about Atelier.
   */
  function dialog({ title, body, field, confirm, cancel, danger, onConfirm, onCancel }) {
    const host = $('at-modal')
    const card = host.querySelector('.at-modal-card')
    card.replaceChildren()
    card.append(el('h2', '', title))
    if (body) card.append(el('p', 'at-note', body))

    let input = null
    if (field) {
      input = document.createElement('input')
      input.className = 'at-input'
      input.placeholder = field.placeholder ?? ''
      input.value = field.value ?? ''
      input.spellcheck = false
      card.append(input)
    }

    const error = el('p', 'at-error', '')
    error.hidden = true
    card.append(error)

    const actions = el('div', 'at-actions')
    const go = button(`at-btn ${danger ? 'at-danger' : 'at-primary'}`, confirm, {})
    const stop = button('at-btn at-ghost', cancel ?? 'Cancel', {})
    go.addEventListener('click', () => {
      const problem = onConfirm(input ? input.value : undefined)
      if (problem) {
        error.textContent = problem
        error.hidden = false
        return
      }
      closeDialog()
    })
    stop.addEventListener('click', () => {
      closeDialog()
      onCancel?.()
    })
    actions.append(go, stop)
    card.append(actions)

    host.hidden = false
    setOpen(true)
    input?.focus()
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go.click()
    })
  }

  function closeDialog() {
    const host = $('at-modal')
    if (host) host.hidden = true
  }

  const dialogOpen = () => !$('at-modal')?.hidden

  /**
   * The last question, and the only one that is not about mechanics.
   *
   * Asked at Save rather than at the start, because at the start nobody knows
   * yet what they are about to build — and asked at all because it is the one
   * thing about a workflow that cannot be worked out from it. The steps, the
   * inputs and what it produces all say what it *does*; an agent can read every
   * one of them and still not know whether this is the right thing to call.
   *
   * Skippable. A description nobody wanted to write would be a worse one than
   * none, and the tools say plainly when it is missing rather than papering
   * over it with a generated sentence.
   */
  function askWhatFor() {
    const save = (description) =>
      send({ t: 'record.save', description }, (res) => {
        if (res?.error) {
          return dialog({
            title: 'Not saved',
            body: res.error,
            confirm: 'Back to the panel',
            cancel: 'Close',
            onConfirm: () => null,
          })
        }
        teardown()
      })

    dialog({
      title: 'What is this workflow for?',
      body:
        'One line, for whoever reaches for it later — including your agent, which reads this to ' +
        'decide whether to call it. Say what it is good for, not what the steps do.',
      field: { placeholder: 'Generates one illustration from a full prompt' },
      confirm: 'Save workflow',
      cancel: 'Save without one',
      onCancel: () => save(''),
      onConfirm: (value) => {
        save(value)
        return null
      },
    })
  }

  function askForName() {
    dialog({
      title: 'Name this workflow',
      body: 'Your agent calls it by this name. Short and kebab-case.',
      field: { placeholder: 'export-invoices', value: rec?.name ?? '' },
      confirm: 'Start recording',
      cancel: 'Discard',
      // Cancelling the name is cancelling the recording: nothing has been built
      // yet, so there is nothing a half-named draft would be good for.
      onCancel: () => send({ t: 'record.discard' }, () => teardown()),
      onConfirm: (value) => {
        // Checked here rather than waiting for the daemon's answer: the reply
        // arrives after this function has returned, so a problem reported from
        // inside the callback would be reported to nobody.
        if (!slug(value)) return 'A workflow needs a name with at least one letter or digit.'
        send({ t: 'record.name', name: value }, () => refresh())
        return null
      },
    })
  }

  /* -------------------------------------------------------------- events */

  function onPanelClick(event) {
    const target = event.target.closest('[data-act],[data-edit],[data-save-edit],[data-cancel-edit],[data-mode]')
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    const d = target.dataset

    if (d.mode) {
      if (d.index != null) {
        // Editing a saved step: the mode is applied when Save is pressed, so
        // the segment just re-renders with the other half selected.
        const index = Number(d.index)
        const step = rec.steps[index]
        step.valueMode = d.mode
        return renderSteps()
      }
      picked.valueMode = d.mode
      return renderCompose()
    }
    if (d.edit != null) {
      editing = Number(d.edit)
      editError = ''
      return renderSteps()
    }
    if (d.cancelEdit) {
      editing = null
      editError = ''
      return refresh()
    }
    if (d.saveEdit != null) {
      const index = Number(d.saveEdit)
      const box = target.closest('.at-edit')
      const patch = {
        valueMode: rec.steps[index].valueMode ?? 'static',
        sampleValue: box.querySelector('[data-role="edit-value"]').value,
      }
      const nameInput = box.querySelector('[data-role="edit-name"]')
      if (nameInput) patch.inputName = slug(nameInput.value)
      if (patch.valueMode === 'dynamic') {
        const name = patch.inputName || rec.steps[index].target
        if (!slug(name)) {
          editError = 'Give the value a name the agent can pass it under.'
          return renderSteps()
        }
        const at = clashAt(name, index)
        if (at !== -1) {
          editError = clashWords(at)
          return renderSteps()
        }
      }
      return send({ t: 'record.setStepValue', index, patch }, (res) => {
        if (res?.error) {
          editError = res.error
          return renderSteps()
        }
        editing = null
        editError = ''
        refresh()
      })
    }

    switch (d.act) {
      case 'collapse':
        return setOpen(false)
      case 'pick':
        return beginPick()
      case 'cancel':
        picked = null
        return renderCompose()
      case 'add':
        return addStep()
      case 'repoint':
        return send(
          {
            t: 'record.repointDone',
            pick: {
              target: picked.identifier,
              identifier: identifierSelector(picked.el, picked.identifier, picked.strategy),
              selectors: selectorsFor(picked.el),
            },
          },
          () => teardown(),
        )
      case 'save':
        return askWhatFor()
      case 'restart':
        return dialog({
          title: 'Start this workflow over?',
          body: `Every step is removed and you build it again from the beginning. There are ${rec.steps.length} of them. A step cannot be taken out on its own — that is what keeps the list a record of what was actually performed.`,
          confirm: 'Remove every step',
          danger: true,
          onConfirm: () => {
            send({ t: 'record.restart' }, () => {
              picked = null
              editing = null
              refresh()
            })
            return null
          },
        })
      case 'discard':
        return dialog({
          title: 'Throw this recording away?',
          body: 'Nothing is saved and the panel closes.',
          confirm: 'Discard it',
          danger: true,
          onConfirm: () => {
            send({ t: 'record.discard' }, () => teardown())
            return null
          },
        })
      default:
        return undefined
    }
  }

  function onPanelChange(event) {
    const role = event.target?.dataset?.role
    if (!picked) return
    if (role === 'action') {
      picked.action = event.target.value
      picked.error = ''
      return renderCompose()
    }
    if (role === 'option' || role === 'key') {
      picked.value = event.target.value
    }
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return
    if (picking) {
      event.preventDefault()
      stopPicking()
      setOpen(true)
      return
    }
    if (dialogOpen()) {
      event.preventDefault()
      closeDialog()
    }
  }

  /* --------------------------------------------------------------- bits */

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }

  function button(className, text, data) {
    const node = el('button', className, text)
    node.type = 'button'
    for (const [key, value] of Object.entries(data ?? {})) node.dataset[key] = value
    return node
  }

  function segButton(mode, text, on, index) {
    const node = button(`at-seg-btn${on ? ' is-on' : ''}`, text, { mode })
    if (index != null) node.dataset.index = String(index)
    node.setAttribute('aria-pressed', on ? 'true' : 'false')
    return node
  }

  function row(key, value) {
    const node = el('div', 'at-row')
    node.append(el('span', 'at-k', key), el('span', 'at-v', value))
    return node
  }

  /**
   * What a name becomes once it is written down.
   *
   * The comparison that decides whether two fields are asking for the same
   * thing: "Same text", "SAME Text" and "same_text" all come out `same_text`,
   * and a workflow carrying two of them would hand the agent one input where
   * the person thought they had made two.
   */
  const slug = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24)

  /** The name a recorded step asks for, whichever way it was given one. */
  const askedName = (step) => slug(step.inputName) || slug(step.target)

  /** The index of a step already asking for this name, or -1. `except` is the
   *  step being edited, which is allowed to keep the name it already has. */
  function clashAt(name, except = -1) {
    const key = slug(name)
    if (!key) return -1
    return (rec?.steps ?? []).findIndex(
      (step, i) => i !== except && step.valueMode === 'dynamic' && askedName(step) === key,
    )
  }

  function clashWords(at) {
    const other = rec.steps[at]
    return (
      `Step ${at + 1}, \u201C${other.target || 'another field'}\u201D, already asks the agent for ` +
      `\u201C${askedName(other)}\u201D. Two fields cannot share a name \u2014 the agent passes one ` +
      'value and both would get it. Give this one a different name.'
    )
  }

  /* ----------------------------------------------------------- lifecycle */

  function teardown() {
    stopPicking()
    onLauncherUp()
    window.removeEventListener('resize', clampLauncher)
    document.removeEventListener('click', onCapturePhaseClick, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('pointermove', onPointerMove, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    nestedIn?.removeEventListener('close', comeHome)
    nestedIn = null
    root?.remove()
    root = null
    rec = null
    picked = null
    editing = null
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.t === 'record.begin') {
      rec = msg.recording
      if (!root) {
        build()
        document.addEventListener('click', onCapturePhaseClick, true)
      }
      setOpen(true)
      render()
      if (rec.mode === 'workflow' && !rec.name) askForName()
      respond({ ok: true })
    } else if (msg.t === 'record.end') {
      teardown()
      respond({ ok: true })
    } else {
      respond({ ok: false })
    }
    return true
  })
})()
