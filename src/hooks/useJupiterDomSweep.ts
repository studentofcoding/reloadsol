'use client'

import { useEffect } from 'react'

/**
 * Idle DOM sweep for the Jupiter Terminal widget: removes "Powered by Jupiter"
 * branding spans/logos/jup.ag links and hides stray Jupiter overlay/modals that
 * escape the widget container.
 *
 * Deliberately interval-based and idempotent — the old implementation ran a
 * MutationObserver on document.body whose own style/DOM writes re-triggered the
 * observer (and removing branding from a live React widget makes the widget
 * recreate it), producing a feedback loop that pegged the main thread and
 * crashed the swap pages. A removal here can never schedule another pass.
 */

const SWEEP_INTERVAL_MS = 8_000

type UseJupiterDomSweepOptions = {
  /** id of the container div the Jupiter Terminal mounts into. */
  containerId?: string
  /** Start sweeping only once the page/terminal is ready. */
  enabled?: boolean
}

function isSearchRelated(el: Element): boolean {
  const classList = Array.from(el.classList)
  const hasSearchClasses = classList.some((c) => c.includes('search'))
  const tagName = el.tagName.toLowerCase()
  const isInteractiveElement = [
    'input',
    'button',
    'select',
    'textarea',
    'a',
  ].includes(tagName)
  const role = el.getAttribute('role') ?? ''
  const hasSearchAttributes =
    el.hasAttribute('role') &&
    ['listbox', 'option', 'menu', 'menuitem', 'combobox', 'textbox'].includes(
      role,
    )
  const placeholder = el.getAttribute('placeholder') ?? ''
  const hasSearchPlaceholder = placeholder.toLowerCase().includes('search')
  const hasSearchParent = !!el.closest(
    [
      '[role="listbox"]',
      '[role="menu"]',
      '[class*="search"]',
      '[class*="dropdown"]',
      '[class*="cursor-pointer"]',
      '[class*="bg-interactive"]',
      'input',
      'button',
      'select',
    ].join(', '),
  )
  return (
    hasSearchClasses ||
    hasSearchAttributes ||
    isInteractiveElement ||
    hasSearchPlaceholder ||
    hasSearchParent
  )
}

function isJupiterBrandingText(text: string): boolean {
  const t = text.toLowerCase()
  if (t.includes('powered by jupiter')) return true
  if (t.includes('jupiter terminal')) return true
  if (t.includes('jup.ag')) return true
  if (t.includes('jupiter exchange')) return true
  if (t.includes('jupiter aggregator')) return true
  // Exact short "Jupiter" label (e.g. the logo wordmark).
  if (t === 'jupiter' && t.length <= 10) return true
  return (
    t.includes('powered by') &&
    (t.includes('jupiter') || t.includes('jup') || t.length < 20)
  )
}

/** Remove Jupiter branding text/logos/links inside one root (regular or shadow). */
function stripBranding(root: ParentNode, removed: { n: number }): void {
  for (const span of Array.from(root.querySelectorAll('span'))) {
    const text = span.textContent?.trim() ?? ''
    if (isSearchRelated(span)) continue
    if (isJupiterBrandingText(text)) {
      span.remove()
      removed.n++
    }
  }
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const alt = img.getAttribute('alt') ?? ''
    const src = img.getAttribute('src') ?? ''
    if (
      (alt.toLowerCase().includes('jupiter') ||
        src.toLowerCase().includes('jupiter')) &&
      !isSearchRelated(img)
    ) {
      img.remove()
      removed.n++
    }
  }
  for (const link of Array.from(root.querySelectorAll('a[href*="jup.ag"]'))) {
    if (!isSearchRelated(link)) {
      link.remove()
      removed.n++
    }
  }
}

/** Hide Jupiter overlay elements that escaped the widget and cover the page. */
function hideStrayOverlays(
  container: HTMLElement | null,
  hidden: { n: number },
): void {
  const targets = document.body.querySelectorAll(
    '[class*="jupiter"], [class*="modal"], [class*="overlay"], [class*="dropdown"], [class*="popup"]',
  )
  for (const el of Array.from(targets)) {
    const htmlEl = el as HTMLElement
    const classText = (el.className?.toString?.() ?? '').toLowerCase()
    const isJupiterOverlay =
      classText.includes('jupiter') &&
      (classText.includes('modal') ||
        classText.includes('dropdown') ||
        classText.includes('overlay') ||
        classText.includes('popup'))
    if (!isJupiterOverlay) continue
    // Never touch the widget's own DOM (its modals belong to the swap flow) —
    // only stray copies that escaped into the page shell.
    if (container && (el.id === container.id || el.closest(`#${container.id}`)))
      continue
    if (el.closest('nav') || el.closest('header') || el.closest('main'))
      continue
    if (htmlEl.style.display === 'none') continue
    htmlEl.style.display = 'none'
    hidden.n++
  }
}

function sweepOnce(containerId: string, removed: { n: number }): void {
  const container = document.getElementById(containerId)
  if (container) {
    stripBranding(container, removed)
    const jupiterRoot = container.querySelector('#jupiter-terminal')
    if (jupiterRoot && jupiterRoot.shadowRoot) {
      stripBranding(jupiterRoot.shadowRoot, removed)
    }
  }
  const portal = document.querySelector('#portal-container')
  if (portal && portal !== container) {
    stripBranding(portal, removed)
  }
  hideStrayOverlays(container, removed)
}

export function useJupiterDomSweep(options: UseJupiterDomSweepOptions = {}) {
  const { containerId = 'jupiter-terminal-swap', enabled = true } = options

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return

    const removed = { n: 0 }
    const run = () => {
      if (document.visibilityState === 'hidden') return
      removed.n = 0
      sweepOnce(containerId, removed)
      if (removed.n > 0) {
        console.debug(
          `[jupiter-sweep] cleaned ${removed.n} element(s) from ${containerId}`,
        )
      }
    }

    // First passes shortly after mount and once content has likely loaded.
    const initialTimers = [500, 2500, 6000].map((ms) =>
      setTimeout(run, ms),
    )
    const intervalId = setInterval(run, SWEEP_INTERVAL_MS)

    return () => {
      initialTimers.forEach(clearTimeout)
      clearInterval(intervalId)
    }
  }, [containerId, enabled])
}
