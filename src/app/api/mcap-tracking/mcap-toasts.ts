import {
  isWithinPredictiveRecency,
  scorePredictivePattern,
  type PredictivePatternScore,
} from '@/strategies/social/predictive-pattern-alert'
import type { McapToast, McapToastItem } from '@/types/mcap-toasts'

export type { McapToast, McapToastItem } from '@/types/mcap-toasts'

const TOAST_DEDUP_WINDOW_MS: number = Number(
  process.env.MCAP_TOAST_DEDUP_WINDOW_MS ||
    process.env.NEXT_PUBLIC_MCAP_TOAST_DEDUP_WINDOW_MS ||
    30000,
)

const recentToastKeys: Map<string, number> = new Map()

export function pruneRecentToastKeys(now: number): void {
  const keysToDelete: string[] = []
  recentToastKeys.forEach((ts, key) => {
    if (now - ts > TOAST_DEDUP_WINDOW_MS) keysToDelete.push(key)
  })
  keysToDelete.forEach((key) => recentToastKeys.delete(key))
}

export function computeToastKey(
  prefix: string,
  items: Array<{ address: string; growthPercent?: number; pWinner?: number }>,
  extra?: Record<string, number | string | undefined>,
): string {
  const parts = [prefix]
  if (extra) {
    if (typeof extra.threshold === 'number') {
      parts.push(`thr:${Math.round(extra.threshold * 10) / 10}`)
    }
    if (typeof extra.cap === 'number') {
      parts.push(`cap:${Math.round(extra.cap * 10) / 10}`)
    }
    if (typeof extra.page === 'number') parts.push(`pg:${extra.page}`)
    if (typeof extra.limit === 'number') parts.push(`lm:${extra.limit}`)
    if (typeof extra.pWinner === 'number') {
      parts.push(`pw:${Math.round(extra.pWinner * 1000) / 1000}`)
    }
  }
  const itemSig = items
    .map((i) => {
      const growth =
        typeof i.growthPercent === 'number'
          ? Math.round(i.growthPercent * 10) / 10
          : 'NA'
      const pw =
        typeof i.pWinner === 'number' ? Math.round(i.pWinner * 1000) / 1000 : 'NA'
      return `${i.address}:${growth}:${pw}`
    })
    .sort()
    .join('|')
  parts.push(itemSig)
  return parts.join('|')
}

function pushDeduped(toasts: McapToast[], toast: McapToast, dedupKey: string): void {
  const now = Date.now()
  pruneRecentToastKeys(now)
  const last = recentToastKeys.get(dedupKey)
  if (last && now - last <= TOAST_DEDUP_WINDOW_MS) return
  recentToastKeys.set(dedupKey, now)
  toasts.push({ ...toast, key: dedupKey })
}

export function buildPredictiveToast(
  symbol: string,
  address: string,
  growthPercent: number,
  score: PredictivePatternScore,
): McapToast {
  const pWinnerPct = score.pWinner != null ? Math.round(score.pWinner * 100) : 0
  return {
    type: 'success',
    category: 'predictive',
    title: 'Predictive Winner Pattern',
    message: `${symbol} matches historical winner shape (${pWinnerPct}% confidence)`,
    items: [
      {
        symbol,
        address,
        growthPercent,
        pWinner: score.pWinner ?? undefined,
        predicted: score.predicted ?? undefined,
      },
    ],
  }
}

export function maybePushPredictiveToast(
  toasts: McapToast[],
  params: {
    symbol: string
    address: string
    growthPercent: number
    score: PredictivePatternScore
  },
): void {
  if (!params.score.isPredictive || params.score.pWinner == null) return

  const dedupKey = computeToastKey(
    'predictive',
    [{ address: params.address, growthPercent: params.growthPercent, pWinner: params.score.pWinner }],
    { pWinner: params.score.pWinner },
  )
  pushDeduped(
    toasts,
    buildPredictiveToast(
      params.symbol,
      params.address,
      params.growthPercent,
      params.score,
    ),
    dedupKey,
  )
}

export function pushNewTokenTrackedToast(
  toasts: McapToast[],
  symbol: string,
  address: string,
  growthPercent: number,
): void {
  const dedupKey = computeToastKey('tracked', [{ address }])
  pushDeduped(
    toasts,
    {
      type: 'success',
      category: 'tracked',
      title: 'New Token Tracked',
      message: `${symbol} now tracked`,
      items: [{ symbol, address, growthPercent }],
    },
    dedupKey,
  )
}

export function pushPnlThresholdToast(
  toasts: McapToast[],
  symbol: string,
  address: string,
  growthPercent: number,
  pnlThreshold: number,
): void {
  const dedupKey = computeToastKey(
    'threshold',
    [{ address, growthPercent }],
    { threshold: pnlThreshold },
  )
  pushDeduped(
    toasts,
    {
      type: 'info',
      category: 'threshold',
      title: 'PnL Threshold Reached',
      message: `${symbol} growth ${growthPercent.toFixed(1)}% ≥ ${pnlThreshold}%`,
      items: [{ symbol, address, growthPercent }],
    },
    dedupKey,
  )
}

export async function appendPredictiveToastForToken(
  toasts: McapToast[],
  params: {
    tokenAddress: string
    symbol: string
    growthPercent: number
  },
): Promise<PredictivePatternScore> {
  const score = await scorePredictivePattern(params.tokenAddress)
  maybePushPredictiveToast(toasts, {
    symbol: params.symbol,
    address: params.tokenAddress,
    growthPercent: params.growthPercent,
    score,
  })
  return score
}

export async function buildTrackActionToasts(params: {
  isFirstTime: boolean
  growthPercent?: number
  tokenAddress: string
  symbol: string
  mcapValue?: number
  pnlThreshold: number
}): Promise<McapToast[]> {
  const toasts: McapToast[] = []
  const symbol = params.symbol || 'UNKNOWN'
  const growth =
    typeof params.growthPercent === 'number' && Number.isFinite(params.growthPercent)
      ? params.growthPercent
      : 0

  if (params.isFirstTime) {
    const mcapMsg =
      typeof params.mcapValue === 'number'
        ? `${symbol} now tracked at $${params.mcapValue.toLocaleString()}`
        : `${symbol} now tracked`
    const dedupKey = computeToastKey('tracked', [{ address: params.tokenAddress }])
    pushDeduped(
      toasts,
      {
        type: 'success',
        category: 'tracked',
        title: 'New Token Tracked',
        message: mcapMsg,
        items: [{ symbol, address: params.tokenAddress, growthPercent: growth }],
      },
      dedupKey,
    )

    await appendPredictiveToastForToken(toasts, {
      tokenAddress: params.tokenAddress,
      symbol,
      growthPercent: growth,
    })
  }

  if (growth >= params.pnlThreshold) {
    pushPnlThresholdToast(
      toasts,
      symbol,
      params.tokenAddress,
      growth,
      params.pnlThreshold,
    )
  }

  return toasts
}

type ListTokenLike = {
  token_address: string
  token_symbol?: string | null
  mcap_growth_percent?: number | null
  first_seen_at?: string | null
  pattern_p_winner?: number | null
  pattern_predicted?: 'winner' | 'loser' | null
}

const LIST_PREDICTIVE_SCAN_LIMIT = 3

export function pushHighPerformersToast(
  toasts: McapToast[],
  params: {
    count: number
    pnlThreshold: number
    upperCap: number
    topNames: string[]
    items: McapToastItem[]
    page: number
    limit: number
  },
): void {
  const dedupKey = computeToastKey(
    'list',
    params.items.map((i) => ({
      address: i.address,
      growthPercent: i.growthPercent,
    })),
    {
      threshold: params.pnlThreshold,
      cap: params.upperCap,
      page: params.page,
      limit: params.limit,
    },
  )
  pushDeduped(
    toasts,
    {
      type: 'info',
      category: 'high_performers',
      title: 'High Performers',
      message: `${params.count} tokens ≥ ${params.pnlThreshold}% ≤ ${params.upperCap}% ${params.topNames.length ? `(${params.topNames.join(', ')}...)` : ''}`,
      items: params.items,
    },
    dedupKey,
  )
}

export async function scanListForPredictiveAlerts<T extends ListTokenLike>(
  tokens: T[],
): Promise<{ tokens: T[]; toasts: McapToast[] }> {
  const candidates = tokens
    .filter((t) => t.token_address && isWithinPredictiveRecency(t.first_seen_at))
    .sort((a, b) => {
      const aMs = new Date(a.first_seen_at ?? 0).getTime()
      const bMs = new Date(b.first_seen_at ?? 0).getTime()
      return bMs - aMs
    })
    .slice(0, LIST_PREDICTIVE_SCAN_LIMIT)

  if (candidates.length === 0) {
    return { tokens, toasts: [] }
  }

  const scoreByAddress = new Map<string, PredictivePatternScore>()
  await Promise.all(
    candidates.map(async (token) => {
      const score = await scorePredictivePattern(token.token_address)
      scoreByAddress.set(token.token_address, score)
    }),
  )

  const toasts: McapToast[] = []

  const enriched = tokens.map((token) => {
    const score = scoreByAddress.get(token.token_address)
    if (!score) return token

    const growth =
      typeof token.mcap_growth_percent === 'number' ? token.mcap_growth_percent : 0
    maybePushPredictiveToast(toasts, {
      symbol: token.token_symbol || 'UNKNOWN',
      address: token.token_address,
      growthPercent: growth,
      score,
    })

    return {
      ...token,
      pattern_p_winner: score.pWinner,
      pattern_predicted: score.predicted,
    }
  })

  return { tokens: enriched, toasts }
}
