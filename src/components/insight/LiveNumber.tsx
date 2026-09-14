'use client'

import type { ReactNode } from 'react'
import { Numbers, type NumbersProps } from '@sfinterface/numbers'
import '@sfinterface/numbers/styles.css'

/** Compact USD for scout liq / mcap (and any other live $ figure). */
export const LIVE_NUMBER_COMPACT_USD: Intl.NumberFormatOptions = {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
}

/** Climate Hurst-like H, one decimal. */
export const LIVE_NUMBER_H: Intl.NumberFormatOptions = {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
}

/** Scout / paper scores (integers in the public feed). */
export const LIVE_NUMBER_SCORE: Intl.NumberFormatOptions = {
  maximumFractionDigits: 0,
}

/** Candidate counts and other whole live figures. */
export const LIVE_NUMBER_COUNT: Intl.NumberFormatOptions = {
  maximumFractionDigits: 0,
}

type LiveNumberProps = Omit<NumbersProps, 'value'> & {
  value: number | null | undefined
  fallback?: ReactNode
}

/**
 * Trading-surface rolling number. Typography is inherited; motion is capped
 * to the shipped insight UI budget (emil-design-eng <300ms).
 */
export default function LiveNumber({
  value,
  fallback = '—',
  className,
  duration = 240,
  locale = 'en-US',
  ...rest
}: LiveNumberProps) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return <span className={className}>{fallback}</span>
  }
  return (
    <Numbers
      value={value}
      locale={locale}
      duration={duration}
      className={['insight-live-number', className].filter(Boolean).join(' ')}
      {...rest}
    />
  )
}
