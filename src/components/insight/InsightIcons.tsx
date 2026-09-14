/** One SVG set, currentColor, stroke tuned to adjacent text weight. */

export function ChevronGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {/* Path biased 0.5px right so the chevron sits optically in the box */}
      <path d="M6.5 3.5 11 8l-4.5 4.5" />
    </svg>
  )
}

export function BookmarkOutline({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M4 2.75h8v10.5L8 11.25 4 13.25V2.75Z" />
    </svg>
  )
}

export function BookmarkFill({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M4 2.75h8v10.5L8 11.25 4 13.25V2.75Z" />
    </svg>
  )
}
