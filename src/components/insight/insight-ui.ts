/**
 * Shared craft for `/dev/insight`, Header climate chip, `/buy` scout link,
 * and light Header/network chrome.
 *
 * Explicit skill map (same as Flowey/terminal):
 * - Apple HIG — content first, floating chrome, layered materials,
 *   blur on sticky Header only
 * - better-ui (jakubkrehel/skills) — concentric radii, shadows for elevation,
 *   scale(0.96) exactly, cubic-bezier(0.2, 0, 0, 1), icon 0.25 + blur(4px),
 *   named transition properties, ~100ms stagger, fine-pointer hover
 * - emil-design-eng (emilkowalski/skills) — cubic-bezier(0.23, 1, 0.32, 1)
 *   enters, UI <300ms, no scale(0) / ease-in / transition:all, @starting-style
 */

/** better-ui press: interruptible CSS, 150ms, scale(0.96) exactly. */
export const insightPress =
  'origin-center transition-[transform,background-color,color,box-shadow,opacity] duration-150 ease-out-strong active:scale-[0.96] disabled:active:scale-100 motion-reduce:transition-[background-color,color,opacity] motion-reduce:duration-100 motion-reduce:active:scale-100'

export const insightPressQuiet =
  'transition-[background-color,color,box-shadow,opacity] duration-150 ease-out-strong motion-reduce:duration-100'

/** Transparent sticky shell so content peeks around the floating bar. */
export const chromeFloat =
  'chrome-float sticky top-0 z-50 bg-transparent px-3 pt-2 pb-2'

/**
 * Light glass bar (Apple primary material). Soft blur lives here only — not on
 * insight cards, rows, or network tabs in the content layer.
 */
export const chromePrimary =
  'chrome-primary mx-auto flex min-h-12 w-full max-w-4xl items-center justify-between gap-2 rounded-[22px] px-3 py-1.5 md:px-4'

export const chromeNetworkSeg =
  'chrome-network-seg inline-flex rounded-full p-0.5'

export const chromeNetworkTab = `rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-[0.01em] ${insightPress}`

export const chromeNetworkTabOn =
  'bg-white text-neutral-900 shadow-[0_1px_2px_rgba(0,0,0,0.12)]'

export const chromeNetworkTabOff =
  'bg-transparent text-neutral-600 fine-hover:text-neutral-900'

export const chromeConnect =
  `inline-flex items-center justify-center rounded-full bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white ${insightPress} fine-hover:bg-neutral-800`

export const chromeGhost =
  `rounded-full px-2.5 py-1.5 text-xs font-semibold text-neutral-700 ${insightPress} fine-hover:bg-black/[0.06]`

/** Nav sits under the floating header; no blur (not glass-on-glass). */
export const navSticky =
  'sticky top-[var(--chrome-header-height)] z-40 hidden bg-transparent px-2 pt-2 md:block'

/** better-ui press 0.96 + named props (never transition-all). */
export const navChromeItem =
  'origin-center transition-[transform,background-color,color] duration-150 ease-out-strong active:scale-[0.96] motion-reduce:transition-[background-color,color] motion-reduce:active:scale-100'

export const navMobileBar =
  'material-secondary fixed bottom-0 left-0 right-0 z-[9999] md:hidden'

/**
 * better-ui concentric: outer 24px + 12px padding → inner 12px (rounded-xl).
 * Secondary content material — no backdrop-filter.
 */
export const insightCard = 'material-secondary rounded-[24px] p-3'

export const insightCardInner = 'rounded-xl'

/** better-ui motion restraint: high-frequency row hover ≤100ms, no scale. */
export const insightRow =
  'material-tertiary rounded-xl px-3 py-2 transition-[background-color,box-shadow] duration-100 ease-out-strong motion-reduce:transition-[background-color] fine-hover:bg-white/[0.05]'

export const insightSeg = 'material-tertiary inline-flex rounded-xl p-1'

export const insightSegTabBase = 'rounded-lg px-3 py-1.5 text-xs font-medium'

/** Trailing chevron: icon-side padding 2px tighter (better-ui optical). */
export const insightLink = `inline-flex items-center gap-1 rounded-full ps-2.5 pe-2 py-1 text-xs font-medium text-sky-200 ${insightPress} shadow-elev fine-hover:bg-white/[0.06] fine-hover:text-sky-100`

export const insightEnter = 'insight-enter'
export const insightEnter2 = 'insight-enter insight-enter-d2'
export const insightEnter3 = 'insight-enter insight-enter-d3'
