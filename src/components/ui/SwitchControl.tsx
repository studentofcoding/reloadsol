'use client'

import type { ReactNode } from 'react'

type SwitchControlProps = {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  disabled?: boolean
  children?: ReactNode
  className?: string
  id?: string
}

/** Kobra switch parts: track + spring thumb. Does not change checked semantics. */
export default function SwitchControl({
  checked,
  onCheckedChange,
  disabled = false,
  children,
  className = '',
  id,
}: SwitchControlProps) {
  return (
    <label
      data-slot="switch"
      className={`inline-flex items-center gap-2 ${className}`.trim()}
    >
      <button
        id={id}
        type="button"
        role="switch"
        data-slot="switch-control"
        data-state={checked ? 'on' : 'off'}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className="disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span data-slot="switch-thumb" />
      </button>
      {children ? <span data-slot="switch-label">{children}</span> : null}
    </label>
  )
}
