import { log, logTradeOperation } from '@/utils/unified-logger'
import { formatAppDateTime } from '@/utils/datetime'
import { formatDetailedRiskForDiscord, type RiskAssessmentResult } from '@/utils/risk-assessment'

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_AUTO_TRADE || process.env.DISCORD_WEBHOOK_URL || ''

// Helper to determine if notifications should be enabled
export function shouldEnableNotifications(): boolean {
  const webhookUrl = process.env.DISCORD_WEBHOOK_AUTO_TRADE || process.env.DISCORD_WEBHOOK_URL || ''
  const enabled = webhookUrl !== ''
  
  log.debug('discord_notification', 'Discord notification status check', {
    enabled,
    webhookConfigured: !!webhookUrl,
    webhookUrlLength: webhookUrl.length,
    autoTradeWebhook: !!process.env.DISCORD_WEBHOOK_AUTO_TRADE,
    regularWebhook: !!process.env.DISCORD_WEBHOOK_URL,
    envVarsPresent: {
      DISCORD_WEBHOOK_AUTO_TRADE: !!process.env.DISCORD_WEBHOOK_AUTO_TRADE,
      DISCORD_WEBHOOK_URL: !!process.env.DISCORD_WEBHOOK_URL
    }
  })
  
  logTradeOperation('Discord Status Check', {
    enabled,
    webhookConfigured: !!webhookUrl,
    webhookUrlLength: webhookUrl.length
  })
  
  return enabled
}

async function postToWebhook(content: string) {
  if (!shouldEnableNotifications()) return
  await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  })
}

export async function sendNewTokenDetectionDiscord(params: {
  tokenAddress: string
  tokenSymbol: string | null
  tokenName: string | null
  currentPrice: number
  marketCap: number | null
  organicScore: number | null
  volume1h: number | null
  isRealTrading: boolean
}) {
  const {
    tokenAddress,
    tokenSymbol,
    tokenName,
    currentPrice,
    marketCap,
    organicScore,
    volume1h,
    isRealTrading
  } = params

  const emoji = isRealTrading ? '🔥' : '💻'
  const mode = isRealTrading ? 'LIVE TRADING' : 'SIMULATION'
  const reloadSolLink = `https://reloadsol.app/buy?sol=0.1&mints=${tokenAddress}`

  const lines = [
    `${emoji} New Token Detected (${mode})`,
    ``,
    `📊 **${tokenSymbol || 'UNKNOWN'}** (${tokenName || 'Unknown Name'})`,
    `💰 Price: $${currentPrice.toFixed(8)}`,
    `🏦 Market Cap: ${marketCap ? `$${(marketCap / 1_000_000).toFixed(2)}M` : 'N/A'}`,
    `🎯 Organic Score: ${organicScore ? `${organicScore.toFixed(1)}` : 'N/A'}`,
    `📈 Volume 1h: ${volume1h ? `$${(volume1h / 1_000).toFixed(1)}K` : 'N/A'}`,
    ``,
    `🔗 **Trade on reloadSOL:**`,
    reloadSolLink,
    ``,
    `⏰ ${formatAppDateTime(new Date())}`
  ]

  const content = lines.join('\n')
  logTradeOperation('Discord New Token Detection', { tokenSymbol, tokenAddress, isRealTrading })
  await postToWebhook(content)
}

export async function sendBuyNotificationDiscord(params: {
  tokenSymbol: string | null
  tokenAddress: string
  isSimulated: boolean
  amountSOL: number
  tokensReceived: string
  priceUSD: number
  provider: string
  rpcUsed: string
  responseTime: number
  signature?: string
  totalFees: number
  marketCap?: number
  riskAssessment?: RiskAssessmentResult
  graduatedAt?: string | null
  launchpad?: string | null
}) {
  const {
    tokenSymbol,
    tokenAddress,
    isSimulated,
    amountSOL,
    tokensReceived,
    priceUSD,
    provider,
    rpcUsed,
    responseTime,
    signature,
    totalFees,
    marketCap,
    riskAssessment,
    graduatedAt,
    launchpad,
  } = params

  const emoji = isSimulated ? '💻' : '🔥'
  const mode = isSimulated ? 'SIMULATION' : 'LIVE'
  const title = `${emoji} BUY Executed (${mode})`

  const lines = [
    title,
    ``,
    `🪙 **${tokenSymbol || 'UNKNOWN'}**`,
    `💰 Spent: ${amountSOL} SOL`,
    `🎯 Received: ${parseFloat(tokensReceived).toLocaleString()} tokens`,
    `📊 Price: $${priceUSD.toFixed(8)}`,
    `⚡ Provider: ${provider}`,
    `🌐 RPC: ${rpcUsed}`,
    `⏱️ Response: ${responseTime}ms`,
    `💸 Fees: ${totalFees.toFixed(6)} SOL`,
  ]

  if (marketCap && marketCap > 0) {
    lines.push(`💎 Market Cap: $${marketCap.toLocaleString()}`)
  }

  if (riskAssessment?.riskLevel) {
    const riskEmoji =
      riskAssessment.riskLevel === 'LOW'
        ? '🟢'
        : riskAssessment.riskLevel === 'MED'
          ? '🟡'
          : '🔴'
    lines.push(`${riskEmoji} Risk: ${riskAssessment.riskLevel}`)
    if (riskAssessment.axiomData || riskAssessment.jupiterDetails) {
      lines.push(
        `📈 Metrics: ${formatDetailedRiskForDiscord(
          {
            token_address: tokenAddress,
            token_symbol: tokenSymbol || 'UNKNOWN',
            mcap: marketCap || 0,
            price: priceUSD,
          },
          riskAssessment,
        )}`,
      )
    }
  }

  if (graduatedAt) lines.push(`🎓 Graduated: ${graduatedAt}`)
  if (launchpad) lines.push(`From launchpad: ${launchpad}`)

  if (signature && !isSimulated) {
    lines.push(`🔗 Signature: \`${signature}\``)
    lines.push(`📍 [View on Solscan](https://solscan.io/tx/${signature})`)
  }

  lines.push(``)
  lines.push(`⏰ ${formatAppDateTime(new Date())}`)

  const content = lines.join('\n')
  logTradeOperation('Discord Buy Notification', { tokenSymbol, isSimulated })
  await postToWebhook(content)
}

export type TradeAlertStatus = 'buy' | 'partial-sell' | 'completed'

export async function sendTradeAlertDiscord(params: {
  tokenSymbol: string | null
  status: TradeAlertStatus
  isSimulated: boolean
  currentGain: number
  peakGain: number
  priceUsd: number
  provider?: string
  rpcUsed?: string
  responseTime?: number
}) {
  const {
    tokenSymbol,
    status,
    isSimulated,
    currentGain,
    peakGain,
    priceUsd,
    provider,
    rpcUsed,
    responseTime
  } = params

  const title = `🔔 Trade Alert (${isSimulated ? 'Simulation' : 'LIVE'})`

  const lines = [
    `${status} triggered for ${tokenSymbol ?? 'UNKNOWN'}`,
    `Current Gain: ${currentGain.toFixed(2)}%`,
    `Peak Gain: ${peakGain.toFixed(2)}%`,
    `Price: ${priceUsd.toFixed(6)}`
  ]

  if (provider) lines.push(`Provider: ${provider}`)
  if (rpcUsed) lines.push(`RPC: ${rpcUsed}`)
  if (responseTime !== undefined) lines.push(`Response Time: ${responseTime}ms`)
  lines.push(`Time: ${formatAppDateTime(new Date())}`)

  const content = [title, ...lines].join('\n')
  logTradeOperation('Discord Trade Alert', { tokenSymbol, status })
  await postToWebhook(content)
}

export async function sendStrategyReportDiscord(body: string): Promise<boolean> {
  if (!shouldEnableNotifications()) return false
  try {
    await postToWebhook(`📊 **Strategy Report Digest**\n\`\`\`\n${body.slice(0, 3500)}\n\`\`\``)
    return true
  } catch {
    return false
  }
}