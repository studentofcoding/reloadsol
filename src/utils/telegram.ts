const TELEGRAM_API = 'https://api.telegram.org';

export function isTelegramConfigured(): boolean {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALERT_CHAT_ID);
}

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');
  return token;
}

function getAlertChatId(): string {
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!chatId) throw new Error('TELEGRAM_ALERT_CHAT_ID not configured');
  return chatId;
}

export function getTelegramAdminChatIds(): string[] {
  const raw = process.env.TELEGRAM_ADMIN_CHAT_IDS || '';
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export function isTelegramAdmin(chatId: number | string): boolean {
  const admins = getTelegramAdminChatIds();
  if (admins.length === 0) return true;
  return admins.includes(String(chatId));
}

type TelegramInlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }

export type TelegramSendResult = {
  ok: boolean
  messageId: number | null
  chatId: string | null
}

export async function sendTelegramMessage(
  text: string,
  options?: {
    chatId?: string
    inlineKeyboard?: Array<Array<TelegramInlineButton>>
    parseMode?: 'HTML' | 'Markdown'
  },
): Promise<TelegramSendResult> {
  if (!isTelegramConfigured()) {
    console.log('[Telegram] Skipped (not configured):', text.slice(0, 120))
    return { ok: false, messageId: null, chatId: null }
  }

  try {
    const token = getBotToken()
    const chatId = options?.chatId ?? getAlertChatId()
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: text.slice(0, 4096),
      disable_web_page_preview: true,
    }
    if (options?.parseMode) body.parse_mode = options.parseMode
    if (options?.inlineKeyboard?.length) {
      body.reply_markup = { inline_keyboard: options.inlineKeyboard }
    }

    const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error('[Telegram] sendMessage failed:', response.status, errText)
      return { ok: false, messageId: null, chatId }
    }
    const data = (await response.json()) as {
      ok?: boolean
      result?: { message_id?: number }
    }
    const messageId =
      typeof data.result?.message_id === 'number' ? data.result.message_id : null
    return { ok: Boolean(data.ok), messageId, chatId }
  } catch (error) {
    console.error('[Telegram] sendMessage error:', error)
    return { ok: false, messageId: null, chatId: null }
  }
}

export async function editTelegramMessage(params: {
  chatId: string
  messageId: number
  text: string
  inlineKeyboard?: Array<Array<TelegramInlineButton>>
  parseMode?: 'HTML' | 'Markdown'
}): Promise<boolean> {
  if (!isTelegramConfigured()) return false
  try {
    const token = getBotToken()
    const body: Record<string, unknown> = {
      chat_id: params.chatId,
      message_id: params.messageId,
      text: params.text.slice(0, 4096),
      disable_web_page_preview: true,
    }
    if (params.parseMode) body.parse_mode = params.parseMode
    if (params.inlineKeyboard?.length) {
      body.reply_markup = { inline_keyboard: params.inlineKeyboard }
    }

    const response = await fetch(
      `${TELEGRAM_API}/bot${token}/editMessageText`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (!response.ok) {
      const errText = await response.text()
      // "message is not modified" is fine for idempotent refreshes
      if (errText.includes('message is not modified')) return true
      console.error('[Telegram] editMessageText failed:', response.status, errText)
      return false
    }
    return true
  } catch (error) {
    console.error('[Telegram] editMessageText error:', error)
    return false
  }
}

export async function pinTelegramMessage(params: {
  chatId: string
  messageId: number
  disableNotification?: boolean
}): Promise<boolean> {
  if (!isTelegramConfigured()) return false
  try {
    const token = getBotToken()
    const response = await fetch(`${TELEGRAM_API}/bot${token}/pinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: params.chatId,
        message_id: params.messageId,
        disable_notification: params.disableNotification !== false,
      }),
    })
    if (!response.ok) {
      const errText = await response.text()
      console.error('[Telegram] pinChatMessage failed:', response.status, errText)
      return false
    }
    return true
  } catch (error) {
    console.error('[Telegram] pinChatMessage error:', error)
    return false
  }
}

export async function unpinTelegramMessage(params: {
  chatId: string
  messageId?: number
}): Promise<boolean> {
  if (!isTelegramConfigured()) return false
  try {
    const token = getBotToken()
    const body: Record<string, unknown> = { chat_id: params.chatId }
    if (params.messageId != null) body.message_id = params.messageId
    const response = await fetch(
      `${TELEGRAM_API}/bot${token}/unpinChatMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (!response.ok) {
      const errText = await response.text()
      console.error('[Telegram] unpinChatMessage failed:', response.status, errText)
      return false
    }
    return true
  } catch (error) {
    console.error('[Telegram] unpinChatMessage error:', error)
    return false
  }
}

export async function sendTelegramAlert(
  text: string,
  options?: {
    chatId?: string
    inlineKeyboard?: Array<Array<TelegramInlineButton>>
    parseMode?: 'HTML' | 'Markdown'
  },
): Promise<boolean> {
  const result = await sendTelegramMessage(text, options)
  return result.ok
}

export function getTelegramAlertChatId(): string | null {
  if (!process.env.TELEGRAM_ALERT_CHAT_ID) return null
  try {
    return getAlertChatId()
  } catch {
    return null
  }
}

export async function answerTelegramCallback(callbackQueryId: string, text?: string): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`${TELEGRAM_API}/bot${getBotToken()}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export async function sendDlmmDecisionAlert(params: {
  poolName: string;
  decision: string;
  reason: string;
  pnlPct: number;
  positionId: string;
}): Promise<void> {
  const sign = params.pnlPct >= 0 ? '+' : '';
  const text = [
    `🔔 <b>DLMM Decision</b>`,
    ``,
    `<b>${params.poolName}</b>`,
    `Action: <b>${params.decision}</b>`,
    `PnL: ${sign}${params.pnlPct.toFixed(2)}%`,
    `Reason: ${params.reason}`,
    `Position: <code>${params.positionId.slice(0, 8)}</code>`,
  ].join('\n');

  await sendTelegramAlert(text, {
    parseMode: 'HTML',
    inlineKeyboard: [
      [
        { text: 'Close', callback_data: `close:${params.positionId}` },
        { text: 'Mute', callback_data: `mute:${params.positionId}` },
      ],
    ],
  });
}

export async function sendDlmmScreenAlert(candidates: Array<{ name: string; score: number; feeTvl: number; tvl: number }>): Promise<void> {
  if (candidates.length === 0) return;
  const lines = candidates.slice(0, 5).map((c, i) =>
    `${i + 1}. ${c.name} | score ${c.score.toFixed(1)} | fee/TVL ${(c.feeTvl * 100).toFixed(2)}% | TVL $${(c.tvl / 1000).toFixed(1)}K`,
  );
  await sendTelegramAlert(`🎯 <b>DLMM Hunter — Top Candidates</b>\n\n${lines.join('\n')}`, {
    parseMode: 'HTML',
  });
}

export async function sendStrategyReportTelegram(body: string): Promise<boolean> {
  const chatId = process.env.STRATEGY_REPORT_TELEGRAM_CHAT_ID || process.env.TELEGRAM_ALERT_CHAT_ID
  return sendTelegramAlert(`📊 <b>Strategy Report Digest</b>\n\n<pre>${body.slice(0, 3500)}</pre>`, {
    parseMode: 'HTML',
    chatId,
  })
}

export function isStrategyTrackTelegramEnabled(): boolean {
  if (process.env.STRATEGY_TRACK_TELEGRAM_ENABLED === 'false') return false
  return isTelegramConfigured()
}

function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function formatJupiterTokenLink(mint: string): string {
  return `https://jup.ag/tokens/${mint}`
}

export function formatMcapUsd(mcap: number | null | undefined): string {
  if (mcap == null || !Number.isFinite(mcap) || mcap <= 0) return '—'
  if (mcap >= 1_000_000) return `$${(mcap / 1_000_000).toFixed(2)}M`
  if (mcap >= 1_000) return `$${(mcap / 1_000).toFixed(1)}K`
  return `$${mcap.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

export type StrategyAlertKind = 'open' | 'open_copy' | 'early_copy' | 'close'

function strategyAlertTitle(
  kind: StrategyAlertKind,
  mode: 'SIM' | 'LIVE',
): string {
  switch (kind) {
    case 'open':
      return `🟢 <b>OPEN (${mode})</b>`
    case 'open_copy':
      return `🟢 <b>OPEN · copy trade (${mode})</b>`
    case 'early_copy':
      return `🟡 <b>EARLY · copy trade (${mode})</b>`
    case 'close':
      return `🔴 <b>CLOSE (${mode})</b>`
  }
}

function liveMcapLine(
  entryMcap: number,
  liveMcap?: number | null,
): string | null {
  if (
    typeof liveMcap !== 'number' ||
    !Number.isFinite(liveMcap) ||
    liveMcap <= 0
  ) {
    return null
  }
  if (Math.abs(liveMcap - entryMcap) / Math.max(entryMcap, 1) <= 0.02) {
    return null
  }
  return `Live mcap: ${formatMcapUsd(liveMcap)}`
}

/** Normalized Telegram body for strategy OPEN / CLOSE / EARLY / copy-trade. */
export function buildStrategyAlertText(params: {
  kind: StrategyAlertKind
  strategyId: string
  strategyName: string
  domain: string
  tokenSymbol: string
  tokenAddress: string
  isSimulated?: boolean
  entryMcap?: number | null
  marketCap?: number | null
  liveMcap?: number | null
  entryAt?: string | null
  strategyIds?: string[] | null
  growthPercent?: number
  score?: number
  rationale?: string | null
  seenAt?: string | null
  pWinner?: number | null
  predicted?: 'winner' | 'loser' | null
  pnlPct?: number
  status?: string
  organicScore?: number | null
  topHoldersPct?: number | null
  sm?: number | null
  kol?: number | null
}): string {
  const titleMode: 'SIM' | 'LIVE' =
    params.kind === 'early_copy' || params.isSimulated !== false ? 'SIM' : 'LIVE'

  const symbol = escapeTelegramHtml(params.tokenSymbol || 'UNKNOWN')
  const name = escapeTelegramHtml(params.strategyName)
  const domain = escapeTelegramHtml(params.domain)
  const organicHolders = formatOrganicHoldersLine(
    params.organicScore,
    params.topHoldersPct,
  )
  const smKol = formatSmKolLine(params.sm, params.kol)
  const bodyLines: (string | null)[] = []

  if (params.kind === 'open' || params.kind === 'open_copy') {
    const entry =
      params.entryMcap != null &&
      Number.isFinite(params.entryMcap) &&
      params.entryMcap > 0
        ? params.entryMcap
        : params.marketCap
    if (entry != null && Number.isFinite(entry) && entry > 0) {
      bodyLines.push(`Entry mcap: ${formatMcapUsd(entry)}`)
      bodyLines.push(liveMcapLine(entry, params.liveMcap))
    } else if (params.marketCap != null) {
      bodyLines.push(`Market Cap: ${formatMcapUsd(params.marketCap)}`)
    }
    bodyLines.push(organicHolders)
    bodyLines.push(smKol)
    if (params.entryAt) {
      bodyLines.push(`Entry at: ${escapeTelegramHtml(params.entryAt)}`)
    }
  } else if (params.kind === 'early_copy') {
    if (params.strategyIds && params.strategyIds.length > 0) {
      bodyLines.push(
        `Strategies: ${params.strategyIds
          .map((id) => escapeTelegramHtml(id))
          .join(' · ')}`,
      )
    }
    const growth =
      params.growthPercent != null && Number.isFinite(params.growthPercent)
        ? `${params.growthPercent >= 0 ? '+' : ''}${params.growthPercent.toFixed(1)}%`
        : 'n/a'
    bodyLines.push(`Growth: <b>${growth}</b> (before 100%)`)
    if (params.score != null && Number.isFinite(params.score)) {
      bodyLines.push(`Score: ${params.score.toFixed(0)}`)
    }
    bodyLines.push(
      `Live mcap: ${formatMcapUsd(params.entryMcap ?? params.marketCap)}`,
    )
    bodyLines.push(organicHolders)
    bodyLines.push(smKol)
    bodyLines.push(
      params.pWinner != null && Number.isFinite(params.pWinner)
        ? `Pattern ML (shadow): pW ${params.pWinner.toFixed(2)} → ${params.predicted ?? '—'}`
        : 'Pattern ML (shadow): n/a',
    )
    if (params.rationale) {
      bodyLines.push(`Rationale: ${escapeTelegramHtml(params.rationale)}`)
    }
    if (params.seenAt) {
      bodyLines.push(`Seen at: ${escapeTelegramHtml(params.seenAt)}`)
    }
  } else {
    bodyLines.push(`Market Cap: ${formatMcapUsd(params.marketCap)}`)
    if (params.pnlPct != null && Number.isFinite(params.pnlPct)) {
      const sign = params.pnlPct >= 0 ? '+' : ''
      bodyLines.push(`PnL: ${sign}${params.pnlPct.toFixed(2)}%`)
    }
    bodyLines.push(
      `Result: <b>${escapeTelegramHtml((params.status || 'unknown').toUpperCase())}</b>`,
    )
    bodyLines.push(organicHolders)
    bodyLines.push(smKol)
  }

  return [
    strategyAlertTitle(params.kind, titleMode),
    '',
    `Strategy: <b>${name}</b> (${escapeTelegramHtml(params.strategyId)})`,
    `Domain: ${domain}`,
    `Token: <b>${symbol}</b>`,
    ...bodyLines,
    '',
    formatChartBuyHtmlLine(params.tokenAddress),
    `<code>${escapeTelegramHtml(params.tokenAddress)}</code>`,
  ]
    .filter((line): line is string => line != null)
    .join('\n')
}

export async function sendStrategyTrackOpenAlert(params: {
  strategyId: string
  strategyName: string
  domain: string
  tokenSymbol: string
  tokenAddress: string
  marketCap?: number | null
  isSimulated: boolean
  organicScore?: number | null
  topHoldersPct?: number | null
  sm?: number | null
  kol?: number | null
}): Promise<boolean> {
  if (!isStrategyTrackTelegramEnabled()) return false

  const text = buildStrategyAlertText({
    kind: 'open',
    strategyId: params.strategyId,
    strategyName: params.strategyName,
    domain: params.domain,
    tokenSymbol: params.tokenSymbol,
    tokenAddress: params.tokenAddress,
    isSimulated: params.isSimulated,
    marketCap: params.marketCap,
    entryMcap: params.marketCap,
    organicScore: params.organicScore,
    topHoldersPct: params.topHoldersPct,
    sm: params.sm,
    kol: params.kol,
  })

  return sendTelegramAlert(text, {
    parseMode: 'HTML',
    inlineKeyboard: chartBuyInlineKeyboard(params.tokenAddress),
  })
}

export function formatReloadsolChartLink(mint: string): string {
  return `https://reloadsol.app/chart/${mint}`
}

export function formatReloadsolBuyLink(mint: string, solAmount = 0.1): string {
  return `https://reloadsol.app/buy?sol=${solAmount}&mints=${mint}`
}

/** Telegram Buy button / link — Jupiter token page. */
export function formatTelegramBuyLink(mint: string): string {
  return formatJupiterTokenLink(mint)
}

function formatSmKolLine(
  sm?: number | null,
  kol?: number | null,
): string | null {
  const smN = sm != null && Number.isFinite(sm) ? Math.max(0, sm) : 0
  const kolN = kol != null && Number.isFinite(kol) ? Math.max(0, kol) : 0
  if (smN <= 0 && kolN <= 0) return null
  return `SM ${smN} · KOL ${kolN}`
}

function formatOrganicHoldersLine(
  organicScore?: number | null,
  topHoldersPct?: number | null,
): string | null {
  const parts: string[] = []
  if (organicScore != null && Number.isFinite(organicScore)) {
    parts.push(`Organic ${Math.round(organicScore)}`)
  }
  if (topHoldersPct != null && Number.isFinite(topHoldersPct)) {
    parts.push(`top10 ${Math.round(topHoldersPct)}%`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

function formatChartBuyHtmlLine(mint: string): string {
  const chartLink = formatReloadsolChartLink(mint)
  const buyLink = formatTelegramBuyLink(mint)
  return `<a href="${chartLink}">Chart</a> · <a href="${buyLink}">Buy</a>`
}

function chartBuyInlineKeyboard(mint: string) {
  return [
    [
      { text: 'Chart', url: formatReloadsolChartLink(mint) },
      { text: 'Buy', url: formatTelegramBuyLink(mint) },
    ],
  ]
}

export function buildMcapSimManualTradeAlertText(params: {
  strategyId: string
  strategyName: string
  tokenSymbol: string
  tokenAddress: string
  entryMcap: number
  entryAt?: string | null
  liveMcap?: number | null
  sm?: number | null
  kol?: number | null
  organicScore?: number | null
  topHoldersPct?: number | null
}): string {
  return buildStrategyAlertText({
    kind: 'open_copy',
    strategyId: params.strategyId,
    strategyName: params.strategyName,
    domain: 'mcap_tracker',
    tokenSymbol: params.tokenSymbol,
    tokenAddress: params.tokenAddress,
    isSimulated: true,
    entryMcap: params.entryMcap,
    liveMcap: params.liveMcap,
    entryAt: params.entryAt,
    organicScore: params.organicScore,
    topHoldersPct: params.topHoldersPct,
    sm: params.sm,
    kol: params.kol,
  })
}

export function buildSignalsEarlyEnterAlertText(params: {
  tokenSymbol: string
  tokenAddress: string
  entryMcap: number
  growthPercent: number
  score: number
  rationale?: string | null
  entryAt?: string | null
  pWinner?: number | null
  predicted?: 'winner' | 'loser' | null
  sm?: number | null
  kol?: number | null
  strategyIds?: string[] | null
  strategyId?: string
  strategyName?: string
}): string {
  const strategyId =
    params.strategyId ||
    params.strategyIds?.[0] ||
    'signals_default'
  return buildStrategyAlertText({
    kind: 'early_copy',
    strategyId,
    strategyName: params.strategyName || strategyId,
    domain: 'signals',
    tokenSymbol: params.tokenSymbol,
    tokenAddress: params.tokenAddress,
    isSimulated: true,
    entryMcap: params.entryMcap,
    growthPercent: params.growthPercent,
    score: params.score,
    rationale: params.rationale,
    seenAt: params.entryAt,
    pWinner: params.pWinner,
    predicted: params.predicted,
    sm: params.sm,
    kol: params.kol,
    strategyIds: params.strategyIds,
  })
}

export async function sendSignalsEarlyEnterAlert(params: {
  tokenSymbol: string
  tokenAddress: string
  entryMcap: number
  growthPercent: number
  score: number
  rationale?: string | null
  entryAt?: string | null
  pWinner?: number | null
  predicted?: 'winner' | 'loser' | null
  sm?: number | null
  kol?: number | null
  strategyIds?: string[] | null
  strategyId?: string
  strategyName?: string
}): Promise<boolean> {
  if (!isStrategyTrackTelegramEnabled()) return false

  return sendTelegramAlert(buildSignalsEarlyEnterAlertText(params), {
    parseMode: 'HTML',
    inlineKeyboard: chartBuyInlineKeyboard(params.tokenAddress),
  })
}

export async function sendMcapSimManualTradeAlert(params: {
  strategyId: string
  strategyName: string
  tokenSymbol: string
  tokenAddress: string
  entryMcap: number
  entryAt?: string | null
  liveMcap?: number | null
  sm?: number | null
  kol?: number | null
  organicScore?: number | null
  topHoldersPct?: number | null
}): Promise<boolean> {
  if (!isStrategyTrackTelegramEnabled()) return false

  return sendTelegramAlert(buildMcapSimManualTradeAlertText(params), {
    parseMode: 'HTML',
    inlineKeyboard: chartBuyInlineKeyboard(params.tokenAddress),
  })
}

export async function sendStrategyTrackCloseAlert(params: {
  strategyId: string
  strategyName: string
  domain: string
  tokenSymbol: string
  tokenAddress: string
  marketCap?: number | null
  pnlPct: number
  status: string
  isSimulated: boolean
  organicScore?: number | null
  topHoldersPct?: number | null
  sm?: number | null
  kol?: number | null
}): Promise<boolean> {
  if (!isStrategyTrackTelegramEnabled()) return false

  const text = buildStrategyAlertText({
    kind: 'close',
    strategyId: params.strategyId,
    strategyName: params.strategyName,
    domain: params.domain,
    tokenSymbol: params.tokenSymbol,
    tokenAddress: params.tokenAddress,
    isSimulated: params.isSimulated,
    marketCap: params.marketCap,
    pnlPct: params.pnlPct,
    status: params.status,
    organicScore: params.organicScore,
    topHoldersPct: params.topHoldersPct,
    sm: params.sm,
    kol: params.kol,
  })

  return sendTelegramAlert(text, {
    parseMode: 'HTML',
    inlineKeyboard: chartBuyInlineKeyboard(params.tokenAddress),
  })
}

export async function sendGmgnRadarAlert(params: {
  review: import('@/strategies/gmgn-radar-review').GmgnRadarReview
  symbol?: string | null
  tokenAddress: string
  category?: string | null
  eventLabel?: string | null
  priceUsd?: number | null
  mcapUsd?: number | null
  /** Override; defaults to DEFAULT_GMGN_RADAR.telegram.minMcapUsd */
  minMcapUsd?: number | null
}): Promise<boolean> {
  if (!isStrategyTrackTelegramEnabled()) return false
  // Only share WATCH / ENTER — SKIP stays in social metadata, not Telegram
  if (params.review.action === 'SKIP') return false

  const { isAnyGmgnRadarStrategyActive } = await import('@/strategies/load-gmgn')
  if (!(await isAnyGmgnRadarStrategyActive())) return false

  const { DEFAULT_GMGN_RADAR } = await import('@/strategies/registry')
  const { shouldSkipRadarTelegramForMcap } = await import(
    '@/strategies/gmgn-radar-thread-sync'
  )
  const minMcap =
    params.minMcapUsd ?? DEFAULT_GMGN_RADAR.telegram.minMcapUsd
  if (shouldSkipRadarTelegramForMcap(params.mcapUsd, minMcap)) return false

  const { formatGmgnRadarTelegramHtml } = await import('@/strategies/gmgn-radar-review')
  const chartLink = formatReloadsolChartLink(params.tokenAddress)
  const buyLink = formatTelegramBuyLink(params.tokenAddress)
  const text = formatGmgnRadarTelegramHtml(params)

  return sendTelegramAlert(text, {
    parseMode: 'HTML',
    inlineKeyboard: [
      [
        { text: '📈 Chart', url: chartLink },
        { text: '🎯 Buy', url: buyLink },
      ],
    ],
  })
}

/** Rug alerts always send (unlike SKIP). */
export async function sendGmgnRadarRugAlert(params: {
  symbol?: string | null
  tokenAddress: string
  previousMcapUsd: number | null
  currentMcapUsd: number | null
  priceUsd?: number | null
  reason: string
}): Promise<boolean> {
  if (!isStrategyTrackTelegramEnabled()) return false

  const { formatGmgnRadarRugTelegramHtml } = await import(
    '@/strategies/gmgn-radar-review'
  )
  const chartLink = formatReloadsolChartLink(params.tokenAddress)
  const text = formatGmgnRadarRugTelegramHtml(params)

  return sendTelegramAlert(text, {
    parseMode: 'HTML',
    inlineKeyboard: [[{ text: '📈 Chart', url: chartLink }]],
  })
}
