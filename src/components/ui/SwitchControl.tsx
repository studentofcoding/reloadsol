'use client'

import { useId, type ReactNode } from 'react'

type SwitchControlProps = {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  disabled?: boolean
  children?: ReactNode
  className?: string
  id?: string
}

/** Kobra switch parts: track + spring thumb. 44px hit target around the knob. */
export default function SwitchControl({
  checked,
  onCheckedChange,
  disabled = false,
  children,
  className = '',
  id,
}: SwitchControlProps) {
  const uid = useId()
  const labelId = `${uid}-label`

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
        aria-labelledby={children ? labelId : undefined}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className="relative inline-flex size-11 shrink-0 items-center justify-center disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span data-slot="switch-track" aria-hidden>
          <span data-slot="switch-thumb" />
        </span>
      </button>
      {children ? (
        <span id={labelId} data-slot="switch-label">
          {children}
        </span>
      ) : null}
    </label>
  )
}
