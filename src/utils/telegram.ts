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

export async function sendTelegramAlert(
  text: string,
  options?: {
    chatId?: string;
    inlineKeyboard?: Array<Array<TelegramInlineButton>>;
    parseMode?: 'HTML' | 'Markdown';
  },
): Promise<boolean> {
  if (!isTelegramConfigured()) {
    console.log('[Telegram] Skipped (not configured):', text.slice(0, 120));
    return false;
  }

  try {
    const token = getBotToken();
    const chatId = options?.chatId ?? getAlertChatId();
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: text.slice(0, 4096),
      disable_web_page_preview: true,
    };
    if (options?.parseMode) body.parse_mode = options.parseMode;
    if (options?.inlineKeyboard?.length) {
      body.reply_markup = { inline_keyboard: options.inlineKeyboard };
    }

    const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[Telegram] sendMessage failed:', response.status, errText);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[Telegram] sendMessage error:', error);
    return false;
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

export async function sendStrategyTrackOpenAlert(params: {
  strategyId: string
  strategyName: string
  domain: string
  tokenSymbol: string
  tokenAddress: string
  marketCap?: number | null
  isSimulated: boolean
}): Promise<boolean> {
  if (!isStrategyTrackTelegramEnabled()) return false

  const mode = params.isSimulated ? 'SIM' : 'LIVE'
  const symbol = escapeTelegramHtml(params.tokenSymbol || 'UNKNOWN')
  const name = escapeTelegramHtml(params.strategyName)
  const domain = escapeTelegramHtml(params.domain)
  const link = formatJupiterTokenLink(params.tokenAddress)

  const text = [
    `<a href="${link}">${link}</a>`,
    '',
    `🟢 <b>Strategy OPEN (${mode})</b>`,
    '',
    `Strategy: <b>${name}</b> (${escapeTelegramHtml(params.strategyId)})`,
    `Domain: ${domain}`,
    `Market Cap: ${formatMcapUsd(params.marketCap)}`,
    `Token: ${symbol}`,
    ``,
  ].join('\n')

  return sendTelegramAlert(text, { parseMode: 'HTML' })
}

export function formatReloadsolChartLink(mint: string): string {
  return `https://reloadsol.app/chart/${mint}`
}

export function formatReloadsolBuyLink(mint: string, solAmount = 0.1): string {
  return `https://reloadsol.app/buy?sol=${solAmount}&mints=${mint}`
}

export function buildMcapSimManualTradeAlertText(params: {
  strategyId: string
  strategyName: string
  tokenSymbol: string
  tokenAddress: string
  entryMcap: number
  entryAt?: string | null
  liveMcap?: number | null
}): string {
  const symbol = escapeTelegramHtml(params.tokenSymbol || 'UNKNOWN')
  const name = escapeTelegramHtml(params.strategyName)
  const chartLink = formatReloadsolChartLink(params.tokenAddress)
  const buyLink = formatReloadsolBuyLink(params.tokenAddress)
  const jupLink = formatJupiterTokenLink(params.tokenAddress)
  const entryAt =
    typeof params.entryAt === 'string' && params.entryAt
      ? escapeTelegramHtml(params.entryAt)
      : null
  const live =
    typeof params.liveMcap === 'number' &&
    Number.isFinite(params.liveMcap) &&
    params.liveMcap > 0 &&
    Math.abs(params.liveMcap - params.entryMcap) / Math.max(params.entryMcap, 1) > 0.02
      ? formatMcapUsd(params.liveMcap)
      : null

  return [
    `🟢 <b>Mcap Sim OPEN — copy trade</b>`,
    '',
    `Strategy: <b>${name}</b> (${escapeTelegramHtml(params.strategyId)})`,
    `Token: <b>${symbol}</b>`,
    `Entry mcap: ${formatMcapUsd(params.entryMcap)}`,
    live ? `Live mcap: ${live}` : null,
    entryAt ? `Entry at: ${entryAt}` : null,
    '',
    `<a href="${chartLink}">Chart</a> · <a href="${buyLink}">Buy</a> · <a href="${jupLink}">Jupiter</a>`,
    `<code>${escapeTelegramHtml(params.tokenAddress)}</code>`,
  ]
    .filter((line): line is string => line != null)
    .join('\n')
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
}): string {
  const symbol = escapeTelegramHtml(params.tokenSymbol || 'UNKNOWN')
  const chartLink = formatReloadsolChartLink(params.tokenAddress)
  const buyLink = formatReloadsolBuyLink(params.tokenAddress)
  const jupLink = formatJupiterTokenLink(params.tokenAddress)
  const growth = Number.isFinite(params.growthPercent)
    ? `${params.growthPercent >= 0 ? '+' : ''}${params.growthPercent.toFixed(1)}%`
    : 'n/a'
  const entryAt =
    typeof params.entryAt === 'string' && params.entryAt
      ? escapeTelegramHtml(params.entryAt)
      : null
  const rationale =
    typeof params.rationale === 'string' && params.rationale
      ? escapeTelegramHtml(params.rationale)
      : null
  const mlLine =
    params.pWinner != null && Number.isFinite(params.pWinner)
      ? `Pattern ML (shadow): pW ${params.pWinner.toFixed(2)} → ${params.predicted ?? '—'}`
      : 'Pattern ML (shadow): n/a'

  return [
    `🟡 <b>Early Signals Enter — copy trade</b>`,
    '',
    `Token: <b>${symbol}</b>`,
    `Growth: <b>${growth}</b> (before 100%)`,
    `Score: ${params.score.toFixed(0)}`,
    `Live mcap: ${formatMcapUsd(params.entryMcap)}`,
    mlLine,
    rationale ? `Rationale: ${rationale}` : null,
    entryAt ? `Seen at: ${entryAt}` : null,
    '',
    `<a href="${chartLink}">Chart</a> · <a href="${buyLink}">Buy</a> · <a href="${jupLink}">Jupiter</a>`,
    `<code>${escapeTelegramHtml(params.tokenAddress)}</code>`,
  ]
    .filter((line): line is string => line != null)
    .join('\n')
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
}): Promise<boolean> {
  if (!isStrategyTrackTelegramEnabled()) return false

  const chartLink = formatReloadsolChartLink(params.tokenAddress)
  const buyLink = formatReloadsolBuyLink(params.tokenAddress)

  return sendTelegramAlert(buildSignalsEarlyEnterAlertText(params), {
    parseMode: 'HTML',
    inlineKeyboard: [
      [
        { text: 'Chart', url: chartLink },
        { text: 'Buy', url: buyLink },
      ],
    ],
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
}): Promise<boolean> {
  if (!isStrategyTrackTelegramEnabled()) return false

  const chartLink = formatReloadsolChartLink(params.tokenAddress)
  const buyLink = formatReloadsolBuyLink(params.tokenAddress)

  return sendTelegramAlert(buildMcapSimManualTradeAlertText(params), {
    parseMode: 'HTML',
    inlineKeyboard: [
      [
        { text: 'Chart', url: chartLink },
        { text: 'Buy', url: buyLink },
      ],
    ],
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
}): Promise<boolean> {
  if (!isStrategyTrackTelegramEnabled()) return false

  const mode = params.isSimulated ? 'SIM' : 'LIVE'
  const sign = params.pnlPct >= 0 ? '+' : ''
  const symbol = escapeTelegramHtml(params.tokenSymbol || 'UNKNOWN')
  const name = escapeTelegramHtml(params.strategyName)
  const domain = escapeTelegramHtml(params.domain)
  const result = escapeTelegramHtml((params.status || 'unknown').toUpperCase())
  const link = formatJupiterTokenLink(params.tokenAddress)

  const text = [
    `<a href="${link}">${link}</a>`,
    '',
    `🔴 <b>Strategy CLOSE (${mode})</b>`,
    '',
    `Strategy: <b>${name}</b> (${escapeTelegramHtml(params.strategyId)})`,
    `Domain: ${domain}`,
    `Token: ${symbol}`,
    `Market Cap: ${formatMcapUsd(params.marketCap)}`,
    `PnL: ${sign}${params.pnlPct.toFixed(2)}%`,
    `Result: <b>${result}</b>`,
  ].join('\n')

  return sendTelegramAlert(text, { parseMode: 'HTML' })
}

export async function sendGmgnRadarAlert(params: {
  review: import('@/strategies/gmgn-radar-review').GmgnRadarReview
  symbol?: string | null
  tokenAddress: string
  category?: string | null
  eventLabel?: string | null
  priceUsd?: number | null
  mcapUsd?: number | null
}): Promise<boolean> {
  if (!isStrategyTrackTelegramEnabled()) return false
  // Only share WATCH / ENTER — SKIP stays in social metadata, not Telegram
  if (params.review.action === 'SKIP') return false

  const { formatGmgnRadarTelegramHtml } = await import('@/strategies/gmgn-radar-review')
  const chartLink = formatReloadsolChartLink(params.tokenAddress)
  const buyLink = formatReloadsolBuyLink(params.tokenAddress)
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
