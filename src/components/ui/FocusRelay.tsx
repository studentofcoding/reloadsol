'use client'

import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
} from 'react'

const FOCUS_TARGET =
  'input:not([type="range"]):not([type="checkbox"]):not([type="hidden"]), select, textarea'

function isFocusTarget(node: EventTarget | null): node is HTMLElement {
  return node instanceof HTMLElement && node.matches(FOCUS_TARGET)
}

/**
 * Kobra OTP-ring idea for multi-field forms: one shared ring that morphs
 * between the active input/select via Kinetics spring + symmetric size.
 */
export default function FocusRelay({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)
  const [active, setActive] = useState(false)

  const measure = useCallback((el: HTMLElement) => {
    const root = rootRef.current
    if (!root) return
    const r = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    setBox({
      x: r.left - b.left,
      y: r.top - b.top,
      w: r.width,
      h: r.height,
    })
  }, [])

  const onFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
    if (!isFocusTarget(event.target)) return
    measure(event.target)
    setActive(true)
  }

  const onBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && rootRef.current?.contains(next) && isFocusTarget(next)) {
      return
    }
    setActive(false)
  }

  return (
    <div
      ref={rootRef}
      data-slot="focus-relay"
      className={className}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      <span
        data-slot="focus-ring"
        data-active={active && box ? 'true' : 'false'}
        aria-hidden
        style={
          box
            ? ({
                '--x': `${box.x}px`,
                '--y': `${box.y}px`,
                '--w': `${box.w}px`,
                '--h': `${box.h}px`,
              } as CSSProperties)
            : undefined
        }
      />
      {children}
    </div>
  )
}
