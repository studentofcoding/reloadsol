'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  readSignalsStrategyTemplate,
  resolveSignalsStrategyId,
  SIGNALS_STRATEGY_STORAGE_KEY,
  writeSignalsStrategyTemplate,
  type SignalsStrategyTemplate,
} from '@/utils/signals-strategy-id'

export function useSignalsStrategy() {
  const [template, setTemplateState] = useState<SignalsStrategyTemplate>(
    readSignalsStrategyTemplate,
  )

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SIGNALS_STRATEGY_STORAGE_KEY || !event.newValue) return
      if (event.newValue === 'default' || event.newValue === 'sell_over_100') {
        setTemplateState(event.newValue)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setTemplate = useCallback((next: SignalsStrategyTemplate) => {
    writeSignalsStrategyTemplate(next)
    setTemplateState(next)
  }, [])

  return {
    template,
    strategyId: resolveSignalsStrategyId(template),
    setTemplate,
  }
}
