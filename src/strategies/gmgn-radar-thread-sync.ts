/** Upsert / finalize Radar Telegram lifecycle threads. */

import {
  evaluateRadarComeback,
  evaluateRadarDrawdownDeath,
  pctChange,
} from './gmgn-radar-comeback'
import type { GmgnRadarReview } from './gmgn-radar-review'
import {
  formatGmgnRadarLiveThreadCaption,
  formatGmgnRadarLiveThreadHtml,
} from './gmgn-radar-review'
import {
  formatOhlcTelegramPre,
  loadAndRenderOhlcPng,
  sendTelegramOhlcPhotoOrText,
} from './ohlc-telegram-paint'
import {
  ensureRadarAlertThreadsTable,
  getLatestDeadRadarThread,
  getNextRadarLifecycle,
  getOpenRadarThread,
  insertRadarThread,
  markRadarThreadDead,
  updateOpenRadarThread,
  type RadarAlertThread,
  type RadarAlertThreadKind,
} from './gmgn-radar-threads-db'
import type { GmgnRadarConfig } from './types'
import { maybeOpenGmgnComebackSim } from './gmgn-comeback-sim'
import {
  editTelegramMessage,
  editTelegramMessageMedia,
  formatJupiterTokenLink,
  formatReloadsolChartLink,
  getTelegramAlertChatId,
  isStrategyTrackTelegramEnabled,
} from '@/utils/telegram'
import { unmarkTokenRug } from '@/utils/rug-list/service'

function chartKeyboard(tokenAddress: string) {
  return [
    [
      { text: '📈 Chart', url: formatReloadsolChartLink(tokenAddress) },
      { text: '🎯 Buy', url: formatJupiterTokenLink(tokenAddress) },
    ],
  ]
}

function ratchetPeak(a: number | null, b: number | null): number | null {
  if (a == null) return b
  if (b == null) return a
  return Math.max(a, b)
}

function ratchetTrough(a: number | null, b: number | null): number | null {
  if (a == null) return b
  if (b == null) return a
  return Math.min(a, b)
}

export type RadarThreadSyncInput = {
  radar: GmgnRadarConfig
  review: GmgnRadarReview
  tokenAddress: string
  symbol: string
  category: string
  sm: number
  kol: number
  priceUsd: number | null
  mcapUsd: number | null
  /** Hard ban from price dump rules */
  hardDead: boolean
  hardDeadReason: string | null
}

export type RadarThreadSyncResult = {
  action: 'skipped' | 'opened' | 'updated' | 'died' | 'comeback' | 'legacy'
  thread: RadarAlertThread | null
}

const DEFAULT_TELEGRAM_MIN_MCAP_USD = 20_000

/** Skip new/comeback Telegram when known mcap is below configured floor. */
export function shouldSkipRadarTelegramForMcap(
  mcapUsd: number | null | undefined,
  minMcapUsd: number | null | undefined,
): boolean {
  const min =
    minMcapUsd == null || !Number.isFinite(minMcapUsd)
      ? DEFAULT_TELEGRAM_MIN_MCAP_USD
      : minMcapUsd
  // Explicit 0 disables the floor.
  if (min <= 0) return false
  if (mcapUsd == null || !Number.isFinite(mcapUsd) || mcapUsd <= 0) {
    return false
  }
  return mcapUsd < min
}

async function renderAndEdit(
  thread: RadarAlertThread,
  params: {
    kind: 'new' | 'comeback' | 'dead'
    review: GmgnRadarReview
    symbol: string
    category: string
    priceUsd: number | null
    mcapUsd: number | null
    pricePctVsLast: number | null
    mcapPctVsLast: number | null
    peakSm: number
    peakKol: number
    peakMcapUsd?: number | null
    deathReason?: string | null
  },
): Promise<void> {
  const { bars, png } = await loadAndRenderOhlcPng(
    thread.token_address,
    params.symbol,
  )
  const captionBase = {
    kind: params.kind,
    review: params.review,
    symbol: params.symbol,
    tokenAddress: thread.token_address,
    category: params.category,
    lifecycle: thread.lifecycle,
    peakSm: params.peakSm,
    peakKol: params.peakKol,
    initialPriceUsd: thread.initial_price_usd,
    initialMcapUsd: thread.initial_mcap_usd,
    priceUsd: params.priceUsd,
    mcapUsd: params.mcapUsd,
    pricePctVsLast: params.pricePctVsLast,
    mcapPctVsLast: params.mcapPctVsLast,
    pricePctVsInitial: pctChange(params.priceUsd, thread.initial_price_usd),
    mcapPctVsInitial: pctChange(params.mcapUsd, thread.initial_mcap_usd),
    deathReason: params.deathReason,
    openedAt: thread.opened_at,
    peakMcapUsd: params.peakMcapUsd ?? thread.peak_mcap_usd,
  }

  if (png) {
    const caption = formatGmgnRadarLiveThreadCaption(captionBase)
    const ok = await editTelegramMessageMedia({
      chatId: thread.chat_id,
      messageId: thread.message_id,
      png,
      caption,
      parseMode: 'HTML',
      inlineKeyboard: chartKeyboard(thread.token_address),
    })
    if (ok) return
  }

  // Legacy text threads / media edit failure
  const ohlcPre = formatOhlcTelegramPre(bars)
  const text = formatGmgnRadarLiveThreadHtml({
    ...captionBase,
    ohlcPre: ohlcPre || null,
  })
  await editTelegramMessage({
    chatId: thread.chat_id,
    messageId: thread.message_id,
    text,
    parseMode: 'HTML',
    inlineKeyboard: chartKeyboard(thread.token_address),
  })
}

async function openNewThread(params: {
  kind: RadarAlertThreadKind
  review: GmgnRadarReview
  tokenAddress: string
  symbol: string
  category: string
  sm: number
  kol: number
  priceUsd: number | null
  mcapUsd: number | null
}): Promise<RadarAlertThread | null> {
  const chatId = getTelegramAlertChatId()
  if (!chatId) return null

  const lifecycle = await getNextRadarLifecycle(params.tokenAddress)
  const openedAt = new Date().toISOString()
  const cardBase = {
    kind: params.kind as 'new' | 'comeback',
    review: params.review,
    symbol: params.symbol,
    tokenAddress: params.tokenAddress,
    category: params.category,
    lifecycle,
    peakSm: params.sm,
    peakKol: params.kol,
    initialPriceUsd: params.priceUsd,
    initialMcapUsd: params.mcapUsd,
    priceUsd: params.priceUsd,
    mcapUsd: params.mcapUsd,
    pricePctVsLast: null as number | null,
    mcapPctVsLast: null as number | null,
    pricePctVsInitial: null as number | null,
    mcapPctVsInitial: null as number | null,
    openedAt,
    peakMcapUsd: params.mcapUsd,
  }

  const caption = formatGmgnRadarLiveThreadCaption(cardBase)
  const textBody = formatGmgnRadarLiveThreadHtml({
    ...cardBase,
    ohlcPre: null,
  })
  const sent = await sendTelegramOhlcPhotoOrText({
    tokenAddress: params.tokenAddress,
    symbol: params.symbol,
    caption,
    textBody,
    chatId,
    inlineKeyboard: chartKeyboard(params.tokenAddress),
  })
  if (!sent.ok || sent.messageId == null) return null

  return insertRadarThread({
    token_address: params.tokenAddress,
    token_symbol: params.symbol,
    chat_id: chatId,
    message_id: sent.messageId,
    kind: params.kind,
    lifecycle,
    initial_price_usd: params.priceUsd,
    initial_mcap_usd: params.mcapUsd,
    peak_sm: params.sm,
    peak_kol: params.kol,
  })
}

/**
 * Single-thread Radar Telegram sync.
 * Dead cards stay in chat; comeback opens a new message only.
 */
export async function syncRadarTelegramThread(
  input: RadarThreadSyncInput,
): Promise<RadarThreadSyncResult> {
  if (!isStrategyTrackTelegramEnabled()) {
    return { action: 'skipped', thread: null }
  }
  const { isAnyGmgnRadarStrategyActive } = await import('./load-gmgn')
  if (!(await isAnyGmgnRadarStrategyActive())) {
    return { action: 'skipped', thread: null }
  }
  if (!input.radar.telegram.singleThread) {
    return { action: 'legacy', thread: null }
  }

  await ensureRadarAlertThreadsTable()

  const open = await getOpenRadarThread(input.tokenAddress)
  const dead = open ? null : await getLatestDeadRadarThread(input.tokenAddress)

  const peakSm = Math.max(open?.peak_sm ?? 0, input.sm)
  const peakKol = Math.max(open?.peak_kol ?? 0, input.kol)

  // --- Hard or soft death on open thread ---
  if (open) {
    const peakMcap = ratchetPeak(open.peak_mcap_usd, input.mcapUsd)
    const troughMcap = ratchetTrough(open.trough_mcap_usd, input.mcapUsd)
    const soft = evaluateRadarDrawdownDeath({
      config: input.radar.comeback,
      peakMcapUsd: peakMcap,
      currentMcapUsd: input.mcapUsd,
    })
    const shouldDie = input.hardDead || soft.isDead
    const deathReason = input.hardDead
      ? input.hardDeadReason || 'hard rug/dump'
      : soft.reasons.join('; ')

    const pricePctVsLast = pctChange(input.priceUsd, open.last_price_usd)
    const mcapPctVsLast = pctChange(input.mcapUsd, open.last_mcap_usd)

    if (shouldDie) {
      await renderAndEdit(open, {
        kind: 'dead',
        review: input.review,
        symbol: input.symbol,
        category: input.category,
        priceUsd: input.priceUsd,
        mcapUsd: input.mcapUsd,
        pricePctVsLast,
        mcapPctVsLast,
        peakSm,
        peakKol,
        peakMcapUsd: peakMcap,
        deathReason,
      })
      const closed = await markRadarThreadDead({
        id: open.id,
        death_reason: deathReason,
        last_price_usd: input.priceUsd,
        last_mcap_usd: input.mcapUsd,
        trough_mcap_usd: troughMcap ?? input.mcapUsd,
      })
      return { action: 'died', thread: closed }
    }

    await renderAndEdit(open, {
      kind: open.kind === 'comeback' ? 'comeback' : 'new',
      review: input.review,
      symbol: input.symbol,
      category: input.category,
      priceUsd: input.priceUsd,
      mcapUsd: input.mcapUsd,
      pricePctVsLast,
      mcapPctVsLast,
      peakSm,
      peakKol,
      peakMcapUsd: peakMcap,
    })
    const updated = await updateOpenRadarThread({
      id: open.id,
      token_symbol: input.symbol,
      last_price_usd: input.priceUsd,
      last_mcap_usd: input.mcapUsd,
      peak_mcap_usd: peakMcap,
      trough_mcap_usd: troughMcap,
      peak_sm: peakSm,
      peak_kol: peakKol,
    })
    return { action: 'updated', thread: updated }
  }

  // --- Comeback after dead lifecycle (leave dead msg untouched) ---
  if (dead && !input.hardDead) {
    const comeback = evaluateRadarComeback({
      config: input.radar.comeback,
      radarScore: input.review.score,
      troughMcapUsd: dead.trough_mcap_usd ?? dead.last_mcap_usd,
      currentMcapUsd: input.mcapUsd,
      hasDeadLifecycle: true,
    })
    if (comeback.isComeback) {
      if (input.radar.comeback.unbanOnComeback) {
        try {
          await unmarkTokenRug(input.tokenAddress)
        } catch (err) {
          console.error('[radar-thread] unban on comeback failed:', err)
        }
      }
      if (input.radar.comeback.allowSimReopen) {
        try {
          const sim = await maybeOpenGmgnComebackSim({
            tokenAddress: input.tokenAddress,
            symbol: input.symbol,
            priceUsd: input.priceUsd,
            mcapUsd: input.mcapUsd,
            review: input.review,
            sm: peakSm,
            kol: peakKol,
          })
          if (sim.opened) {
            console.log(
              `[radar-thread] comeback sim reopen ${input.symbol} strategy=${sim.strategyId}`,
            )
          } else {
            console.log(
              `[radar-thread] comeback sim skip ${input.symbol}: ${sim.reason}`,
            )
          }
        } catch (err) {
          console.error('[radar-thread] comeback sim reopen failed:', err)
        }
      }
      // Telegram: ENTER only (WATCH/SKIP stay in-app)
      if (input.review.action !== 'ENTER') {
        return { action: 'skipped', thread: dead }
      }
      if (
        shouldSkipRadarTelegramForMcap(
          input.mcapUsd,
          input.radar.telegram.minMcapUsd,
        )
      ) {
        return { action: 'skipped', thread: dead }
      }
      const thread = await openNewThread({
        kind: 'comeback',
        review: input.review,
        tokenAddress: input.tokenAddress,
        symbol: input.symbol,
        category: input.category,
        sm: peakSm,
        kol: peakKol,
        priceUsd: input.priceUsd,
        mcapUsd: input.mcapUsd,
      })
      return { action: 'comeback', thread }
    }
    // Still dead / not recovered — no new spam
    return { action: 'skipped', thread: dead }
  }

  // --- First sighting ---
  if (input.hardDead) {
    return { action: 'skipped', thread: null }
  }
  // Telegram: ENTER only — WATCH / SKIP stay in-app
  if (input.review.action !== 'ENTER') {
    return { action: 'skipped', thread: null }
  }
  if (
    shouldSkipRadarTelegramForMcap(
      input.mcapUsd,
      input.radar.telegram.minMcapUsd,
    )
  ) {
    return { action: 'skipped', thread: null }
  }

  const thread = await openNewThread({
    kind: 'new',
    review: input.review,
    tokenAddress: input.tokenAddress,
    symbol: input.symbol,
    category: input.category,
    sm: peakSm,
    kol: peakKol,
    priceUsd: input.priceUsd,
    mcapUsd: input.mcapUsd,
  })
  return { action: 'opened', thread }
}
