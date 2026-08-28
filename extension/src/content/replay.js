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

  /** Try every candidate, best score first, until one resolves to a visible node. */
  async function find(selectors, timeoutMs) {
    const ordered = [...(selectors || [])].sort((a, b) => b.score - a.score)
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      for (const candidate of ordered) {
        const el = resolveOne(candidate)
        if (el && visible(el)) return el
        if (el) last = el
      }
      await sleep(120)
    }
    return last
  }

  async function waitFor(condition, timeoutMs) {
    if (!condition) return true
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      switch (condition.kind) {
        case 'visible': {
          const el = await find(condition.selectors, 200)
          if (el && visible(el)) return true
          break
        }
        case 'hidden': {
          const el = await find(condition.selectors, 200)
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
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
    el.focus()
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  window.__atelierReplay = async function replay(step) {
    try {
      if (!(await waitFor(step.waitBefore, step.timeoutMs))) {
        return { ok: false, reason: 'the page never reached the state this step waits for', recoverable: true }
      }

      let el = null
      if (step.selectors?.length) {
        el = await find(step.selectors, step.timeoutMs)
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
            return { ok: true, capture: { as: 'text', value } }
          }
          const attr = step.capture?.attribute || 'src'
          const value = el.getAttribute(attr) || el[attr]
          if (!value) {
            return { ok: false, reason: `the element has no ${attr} yet — it may still be generating`, recoverable: true }
          }
          return { ok: true, capture: { as: 'image', value: new URL(value, location.href).href } }
        }
        default:
          return { ok: false, reason: `unknown step kind "${step.kind}"`, recoverable: false }
      }

      if (!(await waitFor(step.waitAfter, step.timeoutMs))) {
        return { ok: false, reason: 'the expected result never appeared after this step', recoverable: true }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e?.message || String(e), recoverable: true }
    }
  }
})()
