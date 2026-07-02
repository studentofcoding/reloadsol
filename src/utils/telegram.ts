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

export async function sendTelegramAlert(
  text: string,
  options?: {
    chatId?: string;
    inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>;
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
    `🟢 <b>Strategy OPEN (${mode})</b>`,
    '',
    `Strategy: <b>${name}</b> (${escapeTelegramHtml(params.strategyId)})`,
    `Domain: ${domain}`,
    `Market Cap: ${formatMcapUsd(params.marketCap)}`,
    `Token: ${symbol}`,
    `<a href="${link}">${link}</a>`,
  ].join('\n')

  return sendTelegramAlert(text, { parseMode: 'HTML' })
}

export async function sendStrategyTrackCloseAlert(params: {
  strategyId: string
  strategyName: string
  domain: string
  tokenSymbol: string
  tokenAddress: string
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
    `🔴 <b>Strategy CLOSE (${mode})</b>`,
    '',
    `Strategy: <b>${name}</b> (${escapeTelegramHtml(params.strategyId)})`,
    `Domain: ${domain}`,
    `Token: ${symbol}`,
    `PnL: ${sign}${params.pnlPct.toFixed(2)}%`,
    `Result: <b>${result}</b>`,
    `<a href="${link}">${link}</a>`,
  ].join('\n')

  return sendTelegramAlert(text, { parseMode: 'HTML' })
}
