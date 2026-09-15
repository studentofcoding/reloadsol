'use client'

import type { CSSProperties, ReactNode } from 'react'
import {
  chromeNetworkSeg,
  chromeNetworkTab,
  chromeNetworkTabOff,
  chromeNetworkTabOn,
  insightPressQuiet,
  insightSeg,
  insightSegTabBase,
} from '@/components/insight/insight-ui'

export type SegPillOption<T extends string> = {
  id: T
  label: ReactNode
  disabled?: boolean
  title?: string
}

type SegPillListProps<T extends string> = {
  value: T
  options: readonly SegPillOption<T>[]
  onSelect: (id: T) => void
  ariaLabel: string
  /** Header glass vs insight content material. Keeps shipped radii. */
  variant?: 'insight' | 'chrome'
  className?: string
}

/**
 * Kobra tabs craft: named parts + one sliding indicator.
 * Kinetics snap-rail: equal columns, pill width = 1/n, translateX by index.
 */
export default function SegPillList<T extends string>({
  value,
  options,
  onSelect,
  ariaLabel,
  variant = 'insight',
  className = '',
}: SegPillListProps<T>) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  )
  const listClass = variant === 'chrome' ? chromeNetworkSeg : insightSeg
  const triggerBase =
    variant === 'chrome'
      ? chromeNetworkTab
      : `${insightSegTabBase} ${insightPressQuiet}`

  return (
    <div
      data-slot="tabs"
      data-variant={variant}
      role="tablist"
      aria-label={ariaLabel}
      className={`${listClass} ${className}`.trim()}
      style={
        {
          '--tab-count': options.length,
          '--tab-i': index,
        } as CSSProperties
      }
    >
      <span data-slot="tabs-indicator" aria-hidden />
      {options.map((option) => {
        const selected = option.id === value
        const onClass =
          variant === 'chrome' ? chromeNetworkTabOn : 'text-neutral-900'
        const offClass =
          variant === 'chrome'
            ? chromeNetworkTabOff
            : option.disabled
              ? 'cursor-not-allowed text-gray-600'
              : 'text-gray-400 fine-hover:text-gray-200'
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            data-slot="tabs-trigger"
            data-active={selected ? 'true' : 'false'}
            aria-selected={selected}
            disabled={option.disabled}
            title={option.title}
            onClick={() => {
              if (!option.disabled) onSelect(option.id)
            }}
            className={`${triggerBase} ${selected ? onClass : offClass}`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
