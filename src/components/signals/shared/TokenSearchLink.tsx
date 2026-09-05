'use client'

import Link from 'next/link'
import { tokenSearchDetailHref } from './token-search-href'

/** Magnifier link to token map detail for a mint. */
export default function TokenSearchLink({
  address,
  className = '',
}: {
  address: string
  className?: string
}) {
  if (!address) return null
  return (
    <Link
      href={tokenSearchDetailHref(address)}
      prefetch
      title="Open in token search"
      aria-label="Open in token search"
      className={`inline-flex shrink-0 items-center justify-center rounded p-0.5 text-gray-400 hover:bg-gray-700 hover:text-blue-300 ${className}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-3.5 w-3.5"
        aria-hidden
      >
        <path
          fillRule="evenodd"
          d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
          clipRule="evenodd"
        />
      </svg>
    </Link>
  )
}
