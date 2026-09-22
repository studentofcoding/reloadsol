/**
 * CLOSE chart bars: live Tracker OHLC, then stored signal_ohlc_labels.bars,
 * else none (caller sends a GMGN link, not a fake chart).
 * When labels already have bars, a slow/429 live fetch must not hold the close.
 */

import type { OhlcRugBar } from '@/strategies/ohlc-rug-rules'
import { getGmgnKlineUrl } from '@/utils/gmgn'

export type CloseOhlcSource = 'live' | 'labels' | 'none'

export type CloseOhlcResolution = {
  bars: OhlcRugBar[]
  source: CloseOhlcSource
}

/** How long CLOSE waits for live bars when stored labels already exist. */
export const CLOSE_LIVE_OHLC_WAIT_MS = 2_500

export type CloseOhlcLoaders = {
  loadLive: (tokenAddress: string) => Promise<OhlcRugBar[]>
  loadLabels: (tokenAddress: string) => Promise<OhlcRugBar[]>
  liveWaitMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Prefer a live series. If it is empty or still in flight past `liveWaitMs`
 * and stored label bars exist, paint those. Otherwise no bars.
 */
export async function resolveCloseOhlcBars(
  tokenAddress: string,
  loaders: CloseOhlcLoaders,
): Promise<CloseOhlcResolution> {
  const waitMs = loaders.liveWaitMs ?? CLOSE_LIVE_OHLC_WAIT_MS
  const labelsP = loaders.loadLabels(tokenAddress).catch(() => [] as OhlcRugBar[])
  const liveP = loaders.loadLive(tokenAddress).catch(() => [] as OhlcRugBar[])

  let timedOut = false
  const liveOrTimeout = await Promise.race([
    liveP.then((bars) => {
      timedOut = false
      return bars
    }),
    sleep(waitMs).then(() => {
      timedOut = true
      return [] as OhlcRugBar[]
    }),
  ])

  if (!timedOut && liveOrTimeout.length > 0) {
    void labelsP.catch(() => undefined)
    return { bars: liveOrTimeout, source: 'live' }
  }

  const labels = await labelsP
  if (labels.length > 0) {
    void liveP.catch(() => undefined)
    return { bars: labels, source: 'labels' }
  }

  if (timedOut) {
    const rest = await liveP
    if (rest.length > 0) return { bars: rest, source: 'live' }
  }

  return { bars: [], source: 'none' }
}

/** Text-only chart link when neither live nor stored bars exist. */
export function formatGmgnChartFallbackLine(mint: string): string {
  const url = getGmgnKlineUrl(mint)
  return `<a href="${url}">GMGN</a>`
}
