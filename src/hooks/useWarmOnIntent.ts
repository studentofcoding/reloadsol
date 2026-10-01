'use client'

import { useCallback, useEffect, useRef } from 'react'

/** How long the form must sit untouched before it warms itself. */
export const WARM_IDLE_MS_DEFAULT = 1500

/**
 * Warm a swap when the user looks like they are about to need it — the pointer or keyboard reaching the
 * button, or the form sitting idle — rather than on every settled edit.
 *
 * The warm is a **taker-scoped prepare on the Jupiter trade lane** (0.5 rps, shared with real
 * executions), so firing it 400 ms after every keystroke spent the execution budget on numbers nobody had
 * asked for yet. At ~1.5 s of idle it still covers the "type the amount, read the estimate, click" path,
 * and reaching for the button warms immediately — which is when it actually matters.
 *
 * Nothing here is required for correctness: the click path builds on a cold cache. This is purely how
 * early the work starts, so a missed trigger costs latency, not a swap.
 *
 * `key` identifies the warm inputs. Once warmed for a key it will not warm again — re-hovering the same
 * form is free — and a change to the inputs arms a new idle warm.
 */
export function useWarmOnIntent(
  warm: () => void,
  key: string,
  idleMs: number = WARM_IDLE_MS_DEFAULT,
) {
  const warmRef = useRef(warm)
  warmRef.current = warm

  const idleTimer = useRef<number | null>(null)
  const warmedFor = useRef<string | null>(null)

  const cancelIdle = useCallback(() => {
    if (idleTimer.current !== null) {
      window.clearTimeout(idleTimer.current)
      idleTimer.current = null
    }
  }, [])

  const fire = useCallback(
    (forKey: string) => {
      if (warmedFor.current === forKey) return
      warmedFor.current = forKey
      warmRef.current()
    },
    [],
  )

  const warmNow = useCallback(() => {
    cancelIdle()
    fire(key)
  }, [cancelIdle, fire, key])

  useEffect(() => {
    cancelIdle()
    warmedFor.current = null
    if (!key) return
    idleTimer.current = window.setTimeout(() => {
      idleTimer.current = null
      fire(key)
    }, idleMs)
    return cancelIdle
  }, [key, idleMs, cancelIdle, fire])

  return {
    warmNow,
    /** Spread onto the action button. */
    warmProps: { onPointerEnter: warmNow, onFocus: warmNow },
  }
}
