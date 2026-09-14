/**
 * Shared craft for /dev/insight, the Header climate chip, and the thin /buy
 * scout link. Motion follows better-ui + emil-design-eng: named properties,
 * ease-out curves, press scale 0.96, no scale(0) entries.
 */

/** Pressable controls: interruptible CSS, 150ms, scale(0.96). */
export const insightPress =
  'origin-center transition-[transform,background-color,color,box-shadow,opacity] duration-150 ease-out-ui active:scale-[0.96] disabled:active:scale-100 motion-reduce:transition-[background-color,color,opacity] motion-reduce:duration-100 motion-reduce:active:scale-100'

export const insightPressQuiet =
  'transition-[background-color,color,box-shadow,opacity] duration-150 ease-out-ui motion-reduce:duration-100'

/** Nested card: outer 20px + 8px padding → inner 12px (concentric). */
export const insightCard =
  'rounded-[20px] bg-gray-900/60 p-2 shadow-elev'

export const insightCardInner = 'rounded-xl'

export const insightRow =
  'rounded-xl bg-black/35 px-2.5 py-1.5 shadow-elev transition-[background-color,box-shadow] duration-100 ease-out-ui motion-reduce:transition-[background-color] fine-hover:bg-white/[0.04] fine-hover:shadow-elev-hover'

export const insightSeg =
  'inline-flex rounded-xl bg-black/40 p-1 shadow-elev'

export const insightSegTabBase = 'rounded-lg px-3 py-1.5 text-xs font-medium'

export const insightLink =
  `inline-flex items-center gap-1 rounded-full ps-2.5 pe-2 py-1 text-xs font-medium text-sky-200 ${insightPress} shadow-elev fine-hover:bg-white/[0.06] fine-hover:text-sky-100`

export const insightEnter = 'insight-enter'
export const insightEnter2 = 'insight-enter insight-enter-d2'
export const insightEnter3 = 'insight-enter insight-enter-d3'
