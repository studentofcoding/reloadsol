'use client'

import {
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
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
 * Keyboard: Left/Right/Home/End (ARIA tabs, roving tabindex).
 */
export default function SegPillList<T extends string>({
  value,
  options,
  onSelect,
  ariaLabel,
  variant = 'insight',
  className = '',
}: SegPillListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null)
  const index = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  )
  const listClass = variant === 'chrome' ? chromeNetworkSeg : insightSeg
  const triggerBase =
    variant === 'chrome'
      ? `${chromeNetworkTab} min-h-11`
      : `${insightSegTabBase} ${insightPressQuiet} min-h-11`

  const enabledIndexes = options
    .map((option, i) => (option.disabled ? -1 : i))
    .filter((i) => i >= 0)

  const moveTo = (nextIndex: number) => {
    const option = options[nextIndex]
    if (!option || option.disabled) return
    onSelect(option.id)
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-slot="tabs-trigger"]',
      )
      buttons?.[nextIndex]?.focus()
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (enabledIndexes.length === 0) return
    const currentPos = Math.max(0, enabledIndexes.indexOf(index))
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      moveTo(enabledIndexes[(currentPos + 1) % enabledIndexes.length]!)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveTo(
        enabledIndexes[
          (currentPos - 1 + enabledIndexes.length) % enabledIndexes.length
        ]!,
      )
    } else if (event.key === 'Home') {
      event.preventDefault()
      moveTo(enabledIndexes[0]!)
    } else if (event.key === 'End') {
      event.preventDefault()
      moveTo(enabledIndexes[enabledIndexes.length - 1]!)
    }
  }

  return (
    <div
      ref={listRef}
      data-slot="tabs"
      data-variant={variant}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
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
            aria-disabled={option.disabled || undefined}
            tabIndex={selected ? 0 : -1}
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
