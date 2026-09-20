/**
 * Executes one step in the page.
 *
 * Injected fresh per step, so it defines window.__atelierReplay idempotently and
 * keeps no state between calls — the daemon owns the job's position, not us.
 */
;(() => {
  if (window.__atelierReplay) return

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** Resolve a selector candidate to an element. Strategies are tried by the
   *  caller in score order; this just knows how to run one. */
  function resolveOne(candidate) {
    const { strategy, value } = candidate
    try {
      switch (strategy) {
        case 'testid':
        case 'id':
        case 'aria':
        case 'name':
        case 'placeholder':
        case 'css':
          return document.querySelector(value)
        case 'role': {
          // "role:accessible name" — matched case-insensitively on trimmed text.
          const [role, ...rest] = value.split(':')
          const wanted = rest.join(':').trim().toLowerCase()
          const nodes = [...document.querySelectorAll(`[role="${role}"], ${role}`)]
          return (
            nodes.find((n) => {
              const label =
                n.getAttribute('aria-label') || n.textContent || n.value || ''
              return label.trim().toLowerCase() === wanted
            }) || null
          )
        }
        case 'text': {
          const wanted = value.trim().toLowerCase()
          const nodes = [...document.querySelectorAll('button, a, [role="button"], label, span, div')]
          return nodes.find((n) => n.textContent?.trim().toLowerCase() === wanted) || null
        }
        case 'xpath': {
          const r = document.evaluate(value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
          return r.singleNodeValue
        }
        default:
          return null
      }
    } catch {
      return null
    }
  }

  function visible(el) {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return false
    const style = getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
  }

  /**
   * Try every candidate, best score first, until one resolves to a visible node.
   *
   * Returns *which* candidate won as well as the element. That second half is
   * the whole point: the fallback list is what lets a workflow survive a
   * redeploy, and it is also what hides one — a step quietly matching on a
   * positional XPath looks identical to one matching on the data-testid it was
   * recorded with, until the position moves too. Reporting the winner is how
   * the daemon can warn before that happens.
   */
  async function find(selectors, timeoutMs) {
    const ordered = [...(selectors || [])].sort((a, b) => b.score - a.score)
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      for (const candidate of ordered) {
        const el = resolveOne(candidate)
        if (el && visible(el)) return { el, matched: candidate }
        if (el) last = { el, matched: candidate }
      }
      await sleep(120)
    }
    return last
  }

  /** Some callers only want the node. */
  const nodeOf = (hit) => hit?.el ?? null

  async function waitFor(condition, timeoutMs) {
    if (!condition) return true
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      switch (condition.kind) {
        case 'visible': {
          const el = nodeOf(await find(condition.selectors, 200))
          if (el && visible(el)) return true
          break
        }
        case 'hidden': {
          const el = nodeOf(await find(condition.selectors, 200))
          if (!el || !visible(el)) return true
          break
        }
        case 'urlMatches':
          if (new RegExp(condition.pattern).test(location.href)) return true
          break
        case 'delay':
          await sleep(condition.ms)
          return true
        case 'networkIdle':
          await sleep(condition.idleMs || 800)
          return true
        default:
          return true
      }
      await sleep(150)
    }
    return false
  }

  /** Set a value the way a framework notices — React and Vue both listen for
   *  input/change rather than reading .value on their own schedule. */
  function setValue(el, value) {
    el.focus()

    // contenteditable, which is how most rich-text editors are built. Assigning
    // textContent does not reach an editor that maintains its own document model
    // and reconciles the DOM against it; execCommand('insertText') produces the
    // same event sequence as real typing, which such an editor is by definition
    // built to handle.
    if (el.isContentEditable) {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      let inserted = false
      try {
        inserted = document.execCommand('insertText', false, value)
      } catch {
        inserted = false
      }
      if (!inserted) {
        el.textContent = value
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
      }
      return
    }

    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /** What can carry a produced artifact, in the order worth believing. Media
   *  first: when a region holds both a result and a caption link, the result is
   *  the one that was waited for. */
  const SOURCE_TAGS = ['img, video, audio, source, embed, object', 'a[href], iframe']

  /**
   * The URL of whatever the captured element produced.
   *
   * Tries the element itself, then what is inside it, then the enclosing
   * figure — because a recorded target is usually the *region* that was pointed
   * at and the result turns up somewhere in it.
   *
   * This used to look for an `img` and nothing else, which quietly decided what
   * Atelier could produce: a clip, a rendered file, a link offering one as a
   * download all reached this branch and failed asking for an image that was
   * never coming. `download` was in the step type and in the recorder the whole
   * time and had no implementation here. Asking each candidate for whichever
   * source it actually has covers every one of them in a single path.
   *
   * `currentSrc` comes first because on a media element it is the source the
   * browser *chose* — the srcset candidate, or the `source` child that won — and
   * the recorded attribute only holds what the markup asked for.
   */
  function resolveSource(el, attribute) {
    const groups = SOURCE_TAGS.map((tags) => [
      ...(el.querySelectorAll?.(tags) || []),
      ...(el.closest?.('figure, picture')?.querySelectorAll?.(tags) || []),
    ])
    for (const node of [el, ...groups.flat()]) {
      const value =
        node.currentSrc ||
        (attribute && node.getAttribute?.(attribute)) ||
        node.getAttribute?.('src') ||
        node.getAttribute?.('href') ||
        node.getAttribute?.('data') ||
        ''
      if (value.trim()) return value
    }
    return null
  }

  /** Turn a blob: URL into a data: URL. The service worker cannot fetch a blob
   *  belonging to a page's context, so the page has to read it. */
  async function inlineBlob(url) {
    const res = await fetch(url)
    const blob = await res.blob()
    return await new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result)
      fr.onerror = reject
      fr.readAsDataURL(blob)
    })
  }

  window.__atelierReplay = async function replay(step) {
    try {
      if (!(await waitFor(step.waitBefore, step.timeoutMs))) {
        return { ok: false, reason: 'the page never reached the state this step waits for', recoverable: true }
      }

      let el = null
      let matched = null
      if (step.selectors?.length) {
        const hit = await find(step.selectors, step.timeoutMs)
        el = nodeOf(hit)
        matched = hit?.matched ?? null
        if (!el) {
          return {
            ok: false,
            reason: `could not find the element for "${step.note || step.kind}" — the page may have changed, or you may need to sign in`,
            recoverable: true,
          }
        }
        el.scrollIntoView({ block: 'center', behavior: 'instant' })
      }

      switch (step.kind) {
        case 'click':
          el.click()
          break
        case 'type':
          setValue(el, step.value ?? '')
          break
        case 'select':
          setValue(el, step.value ?? '')
          break
        case 'key':
          document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: step.value, bubbles: true }),
          )
          break
        case 'scroll':
          el?.scrollIntoView({ block: 'center' })
          break
        case 'wait':
          break
        case 'manual':
          // Recorded over something we refuse to automate — a password field.
          return { ok: false, reason: step.note || 'this step needs you to do it by hand', recoverable: true }
        case 'capture': {
          const as = step.capture?.as || 'image'
          if (as === 'text') {
            const value = el.value ?? el.textContent ?? ''
            if (!value.trim()) return { ok: false, reason: 'the captured element was empty', recoverable: true }
            return { ok: true, matched, capture: { as: 'text', value } }
          }

          const source = resolveSource(el, step.capture?.attribute)
          if (!source) {
            return {
              ok: false,
              reason: 'nothing with a source inside the captured element yet — it may still be generating',
              recoverable: true,
            }
          }

          const href = new URL(source, location.href).href
          if (href.startsWith('blob:')) {
            return { ok: true, matched, capture: { as, value: await inlineBlob(href) } }
          }
          return { ok: true, matched, capture: { as, value: href } }
        }
        default:
          return { ok: false, reason: `unknown step kind "${step.kind}"`, recoverable: false }
      }

      if (!(await waitFor(step.waitAfter, step.timeoutMs))) {
        return { ok: false, reason: 'the expected result never appeared after this step', recoverable: true }
      }
      return { ok: true, matched }
    } catch (e) {
      return { ok: false, reason: e?.message || String(e), recoverable: true }
    }
  }
})()
