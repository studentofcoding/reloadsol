// Discord notification helpers extracted from src/app/api/trending/track/route.ts (REL-19).
import { log, logTradeOperation } from '@/utils/unified-logger'
import { shouldEnableNotifications, type TradeAlertStatus } from '@/utils/discord'
import { formatAppDateTime } from '@/utils/datetime'
import { DISCORD_MAX_LENGTH, DISCORD_SAFE_LENGTH, DISCORD_WEBHOOK_URL } from './constants'
import type {
  FilteringSummary,
  TokenFilterResult,
  SyncedTradeResult,
  TradingSimulationStatus,
} from './types'

export function truncateDiscordMessage(lines: string[], maxLength: number = DISCORD_SAFE_LENGTH): string {
  let content = lines.join('\n')

  if (content.length <= maxLength) {
    return content
  }

  // Progressive truncation strategy
  let truncatedLines = [...lines]

  // Strategy 1: Remove detailed token information progressively
  while (content.length > maxLength && truncatedLines.length > 10) {
    // Find and remove the longest lines (usually token details)
    const longestIndex = truncatedLines.reduce((maxIdx, line, idx, arr) =>
      line.length > arr[maxIdx].length ? idx : maxIdx, 0)

    if (truncatedLines[longestIndex].includes('💰 Price:') ||
      truncatedLines[longestIndex].includes('🏷️ Symbol:') ||
      truncatedLines[longestIndex].includes('📊 [View Chart]')) {
      truncatedLines.splice(longestIndex, 1)
      content = truncatedLines.join('\n')
    } else {
      break
    }
  }

  // Strategy 2: If still too long, keep only essential information
  if (content.length > maxLength) {
    const essentialLines = truncatedLines.filter(line =>
      line.includes('Token Filtering Summary') ||
      line.includes('Processing Results:') ||
      line.includes('Total Scanned:') ||
      line.includes('Accepted:') ||
      line.includes('Rejected:') ||
      line.includes('Processing Time:') ||
      line.includes('**') && line.includes(':') && !line.includes('💰') ||
      line === '' ||
      line.includes('⏰')
    )

    content = essentialLines.join('\n')
  }

  // Final fallback: Hard truncate with ellipsis
  if (content.length > maxLength) {
    content = content.substring(0, maxLength - 20) + '\n\n... (truncated)'
  }

  return content
}

// Discord notification for skipped tokens (already exist in database)
export async function sendSkippedTokenDiscord(params: {
  tokenSymbol: string | null
  tokenAddress: string
  currentPriceAPI: number
  existingTokenData: {
    status: string
    initial_price_usd: number | null
    last_price_usd: number | null
    peak_price_usd: number | null
    current_gain_percentage: number | null
    peak_gain_percentage: number | null
    tracking_started_at: string | null
    status_changed_at: string | null
    updated_at: string | null
  }
}) {
  try {
    const webhookUrl = 'https://discord.com/api/webhooks/1388575606098100256/c4e6BM2W-htcl2hUF9f_nZcchJZXCgoEe5mV95gDKODTfOto97w9BEjW8C2CgL0QwXrP'

    const timeSinceTracking = params.existingTokenData.tracking_started_at
      ? Math.round((Date.now() - new Date(params.existingTokenData.tracking_started_at).getTime()) / (1000 * 60 * 60 * 24) * 100) / 100
      : 'Unknown'

    const timeSinceStatusChange = params.existingTokenData.status_changed_at
      ? Math.round((Date.now() - new Date(params.existingTokenData.status_changed_at).getTime()) / (1000 * 60 * 60 * 24) * 100) / 100
      : 'N/A'

    const lastUpdateTime = params.existingTokenData.updated_at
      ? Math.round((Date.now() - new Date(params.existingTokenData.updated_at).getTime()) / (1000 * 60)) / 100
      : 'Unknown'

    const priceChangeVsDB = params.existingTokenData.last_price_usd
      ? ((params.currentPriceAPI - params.existingTokenData.last_price_usd) / params.existingTokenData.last_price_usd * 100).toFixed(2)
      : 'N/A'

    const currentVsPeak = params.existingTokenData.peak_price_usd && params.existingTokenData.last_price_usd
      ? ((params.existingTokenData.last_price_usd / params.existingTokenData.peak_price_usd - 1) * 100).toFixed(2)
      : 'N/A'

    const message = `🚫 **Token Skipped - Already Exists**\n\n` +
      `**Token:** ${params.tokenSymbol || 'Unknown'} (${params.tokenAddress.slice(0, 8)}...)\n` +
      `**Status:** ${params.existingTokenData.status}\n` +
      `**Initial Price:** $${params.existingTokenData.initial_price_usd?.toFixed(6) || 'N/A'}\n` +
      `**Last Price (DB):** $${params.existingTokenData.last_price_usd?.toFixed(6) || 'N/A'}\n` +
      `**Current Price (API):** $${params.currentPriceAPI?.toFixed(6)}\n` +
      `**Price Change vs DB:** ${priceChangeVsDB}%\n` +
      `**Peak Price:** $${params.existingTokenData.peak_price_usd?.toFixed(6) || 'N/A'}\n` +
      `**Current PnL:** ${params.existingTokenData.current_gain_percentage?.toFixed(2) || '0.00'}%\n` +
      `**Peak PnL:** ${params.existingTokenData.peak_gain_percentage?.toFixed(2) || '0.00'}%\n` +
      `**Current vs Peak:** ${currentVsPeak}%\n` +
      `**Tracking Started:** ${timeSinceTracking} days ago\n` +
      `**Status Changed:** ${timeSinceStatusChange !== 'N/A' ? `${timeSinceStatusChange} days ago` : 'Never'}\n` +
      `**Last Updated:** ${lastUpdateTime} minutes ago`

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
    })

    console.log(`📤 Discord notification sent for skipped token: ${params.tokenSymbol}`)
  } catch (error) {
    console.error(`❌ Failed to send Discord notification for skipped token ${params.tokenSymbol}:`, error)
  }
}

// Add new Discord notification functions
export async function sendFilteringSummaryDiscord(summary: FilteringSummary, isRealTrading: boolean) {
  log.debug('discord_notification', 'sendFilteringSummaryDiscord called', {
    totalTokens: summary.totalTokens,
    acceptedTokens: summary.acceptedTokens,
    rejectedTokens: summary.rejectedTokens,
    isRealTrading,
    rejectionDetailsCount: summary.rejectionDetails.length
  })

  try {
    const notificationsEnabled = shouldEnableNotifications()
    log.info('discord_notification', 'Discord notifications status check', {
      enabled: notificationsEnabled
    })

    if (!notificationsEnabled) {
      log.warn('discord_notification', 'Discord notifications disabled - skipping filtering summary', {
        webhookUrl: !!DISCORD_WEBHOOK_URL ? 'configured' : 'missing'
      })
      logTradeOperation('Discord Filtering Summary Skipped', {
        reason: 'Notifications disabled',
        webhookUrl: !!DISCORD_WEBHOOK_URL ? 'configured' : 'missing'
      })
      return
    }

    log.info('discord_notification', 'Proceeding with Discord filtering summary notification')

    const emoji = isRealTrading ? '🔥' : '💻'
    const mode = isRealTrading ? 'LIVE TRADING' : 'SIMULATION'

    const lines = [
      `${emoji} Token Filtering Summary (${mode})`,
      ``,
      `📊 **Processing Results:**`,
      `🔍 Total Scanned: ${summary.totalTokens}`,
      `✅ Accepted: ${summary.acceptedTokens}`,
      `❌ Rejected: ${summary.rejectedTokens}`,
      `⚡ Processing Time: ${summary.processingTime}ms`,
      ``,
      `📋 **Rejection Breakdown:**`
    ]

    // Add rejection reasons breakdown with adaptive detail level
    const sortedDetails = summary.rejectionDetails.sort((a, b) => b.count - a.count)

    // Estimate space available for rejection details
    const baseMessageLength = lines.join('\n').length + 50 // +50 for timestamp
    const availableSpace = DISCORD_SAFE_LENGTH - baseMessageLength

    let tokensPerReason = 2 // Start with 2 tokens per reason
    let maxReasons = Math.min(sortedDetails.length, 8) // Limit reasons shown

    // Adjust detail level based on available space
    if (availableSpace < 800) {
      tokensPerReason = 1
      maxReasons = Math.min(sortedDetails.length, 5)
    } else if (availableSpace < 1200) {
      tokensPerReason = 2
      maxReasons = Math.min(sortedDetails.length, 6)
    }

    sortedDetails.slice(0, maxReasons).forEach(detail => {
      lines.push(``)
      lines.push(`${getRejectionEmoji(detail.reason)} **${detail.reason}: ${detail.count}**`)

      // Show limited tokens for each rejection reason
      const topTokens = detail.tokens.slice(0, tokensPerReason)
      topTokens.forEach((token, index) => {
        const tokenName = token.name || token.symbol || 'UNKNOWN'
        const price = token.price ? `$${token.price.toFixed(6)}` : 'N/A' // Reduced precision
        const mcap = token.mcap ? `$${(token.mcap / 1000000).toFixed(1)}M` : 'N/A'
        const score = token.organicScore ? token.organicScore.toFixed(0) : 'N/A' // Reduced precision

        lines.push(`   ${index + 1}. **${tokenName}** (${token.symbol})`)
        lines.push(`      💰 ${price} | 🏦 ${mcap} | 🎯 ${score}`)
      })

      if (detail.tokens.length > tokensPerReason) {
        lines.push(`      ... +${detail.tokens.length - tokensPerReason} more`)
      }
    })

    if (sortedDetails.length > maxReasons) {
      lines.push(``)
      lines.push(`... and ${sortedDetails.length - maxReasons} more rejection reasons`)
    }

    lines.push(``)
    lines.push(`⏰ ${formatAppDateTime(new Date())}`)

    // Apply length management
    const content = truncateDiscordMessage(lines)

    log.debug('discord_notification', 'Discord message prepared with length management', {
      originalLength: lines.join('\n').length,
      finalLength: content.length,
      withinLimit: content.length <= DISCORD_MAX_LENGTH
    })

    log.info('discord_notification', 'Sending Discord webhook request', {
      webhookConfigured: !!DISCORD_WEBHOOK_URL,
      messageLength: content.length
    })

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })

    log.info('discord_notification', 'Discord webhook response received', {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok
    })

    if (!response.ok) {
      const errorText = await response.text()
      log.error('discord_notification', 'Discord webhook failed', new Error(`${response.status} - ${errorText}`), {
        status: response.status,
        errorText,
        messageLength: content.length
      })
      throw new Error(`Discord webhook failed: ${response.status} - ${errorText}`)
    }

    log.info('discord_notification', 'Discord filtering summary sent successfully', {
      totalTokens: summary.totalTokens,
      acceptedTokens: summary.acceptedTokens,
      rejectedTokens: summary.rejectedTokens,
      messageLength: content.length
    })

    logTradeOperation('Discord Filtering Summary Success', {
      totalTokens: summary.totalTokens,
      acceptedTokens: summary.acceptedTokens,
      rejectedTokens: summary.rejectedTokens,
      messageLength: content.length
    })
  } catch (err) {
    log.error('discord_notification', 'Error in sendFilteringSummaryDiscord', err as Error, {
      totalTokens: summary.totalTokens
    })
    logTradeOperation('Discord Filtering Summary Error', {
      totalTokens: summary.totalTokens,
      error: err instanceof Error ? err.message : String(err)
    }, err as Error)
  }
}

export async function sendRejectedTokensDiscord(rejectedTokens: TokenFilterResult[], isRealTrading: boolean) {
  log.debug('discord_notification', 'sendRejectedTokensDiscord called', {
    rejectedTokensCount: rejectedTokens.length,
    isRealTrading
  })

  try {
    const notificationsEnabled = shouldEnableNotifications()
    log.info('discord_notification', 'Discord notifications status for rejected tokens', {
      enabled: notificationsEnabled
    })

    if (!notificationsEnabled || rejectedTokens.length === 0) {
      log.warn('discord_notification', 'Skipping rejected tokens Discord notification', {
        notificationsEnabled,
        hasRejectedTokens: rejectedTokens.length > 0
      })
      return
    }

    log.info('discord_notification', 'Proceeding with Discord rejected tokens notification')

    const emoji = isRealTrading ? '🔥' : '💻'
    const mode = isRealTrading ? 'LIVE TRADING' : 'SIMULATION'

    // Filter tokens with market cap <= 3M and get only symbols
    const filteredTokens = rejectedTokens.filter(result => {
      const mcap = result.token.baseAsset.mcap
      return mcap && mcap <= 3_000_000
    })

    // Dynamic limit based on total count
    let maxTokensToShow = Math.min(10, filteredTokens.length)
    if (filteredTokens.length > 50) {
      maxTokensToShow = 5
    } else if (filteredTokens.length > 20) {
      maxTokensToShow = 8
    }

    const topRejected = filteredTokens.slice(0, maxTokensToShow)

    const lines = [
      `${emoji} Rejected Tokens (${mode}) - Max 3M Market Cap`,
      ``,
      `❌ **Top ${topRejected.length} of ${filteredTokens.length} Rejected Tokens:**`,
      ``
    ]

    // Simple format - only show symbols
    const symbols = topRejected.map(result => result.token.baseAsset.symbol || 'UNKNOWN')
    lines.push(symbols.join(', '))
    lines.push(``)

    if (filteredTokens.length > maxTokensToShow) {
      lines.push(`... and ${filteredTokens.length - maxTokensToShow} more rejected tokens`)
      lines.push(``)
    }

    lines.push(`⏰ ${formatAppDateTime(new Date())}`)

    // Apply length management
    const content = truncateDiscordMessage(lines)

    log.debug('discord_notification', 'Discord rejected tokens message prepared with simplified format', {
      originalLength: lines.join('\n').length,
      finalLength: content.length,
      withinLimit: content.length <= DISCORD_MAX_LENGTH,
      tokensShown: topRejected.length,
      filteredCount: filteredTokens.length,
      totalRejected: rejectedTokens.length
    })

    log.info('discord_notification', 'Sending Discord rejected tokens webhook request', {
      messageLength: content.length
    })

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })

    log.info('discord_notification', 'Discord rejected tokens webhook response received', {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok
    })

    if (!response.ok) {
      const errorText = await response.text()
      log.error('discord_notification', 'Discord rejected tokens webhook failed', new Error(`${response.status} - ${errorText}`), {
        status: response.status,
        errorText,
        messageLength: content.length
      })
      throw new Error(`Discord webhook failed: ${response.status} - ${errorText}`)
    }

    log.info('discord_notification', 'Discord rejected tokens notification sent successfully', {
      rejectedCount: rejectedTokens.length,
      filteredCount: filteredTokens.length,
      tokensShown: topRejected.length,
      messageLength: content.length
    })

    logTradeOperation('Discord Rejected Tokens Success', {
      rejectedCount: rejectedTokens.length,
      filteredCount: filteredTokens.length,
      tokensShown: topRejected.length,
      messageLength: content.length
    })
  } catch (err) {
    log.error('discord_notification', 'Error in sendRejectedTokensDiscord', err as Error, {
      rejectedCount: rejectedTokens.length
    })
    logTradeOperation('Discord Rejected Tokens Error', {
      rejectedCount: rejectedTokens.length,
      error: err instanceof Error ? err.message : String(err)
    }, err as Error)
  }
}

// Helper function to get appropriate emoji for rejection reasons
export function getRejectionEmoji(reason: string): string {
  const emojiMap: { [key: string]: string } = {
    'Price drop too severe': '📉',
    'Price rise too high (1h)': '🚀',
    'Price rise too high (6h)': '📈',
    'Organic score too low': '🎯',
    'Market cap too low': '💸',
    'Market cap too high': '💰',
    'Top holders percentage too high': '👥',
    'Missing required data': '❓'
  }
  return emojiMap[reason] || '❌'
}

export async function sendSyncTradeNotificationDiscord(params: {
  tokenSymbol: string | null
  tokenAddress: string
  operationType: 'buy' | 'sell'
  syncResult: SyncedTradeResult
  isRealTradeExecuted: boolean
  tokenData?: any
}) {
  try {
    if (!shouldEnableNotifications()) {
      logTradeOperation('Discord Sync Notification Skipped', {
        reason: 'Notifications disabled',
        webhookStatus: 'not configured'
      })
      return
    }

    const {
      tokenSymbol,
      tokenAddress,
      operationType,
      syncResult,
      isRealTradeExecuted,
      tokenData
    } = params

    logTradeOperation('Discord Sync Notification Attempt', {
      tokenSymbol,
      tokenAddress,
      operationType,
      isRealTradeExecuted,
      hasDeviation: !!syncResult.deviation
    })

    const emoji = operationType === 'buy' ? '💰' : '💸'
    const title = `${emoji} ${operationType.toUpperCase()} Sync Results`

    const lines = [
      `🔄 **${title}**`,
      ``,
      `🪙 **${tokenSymbol || 'UNKNOWN'}**`,
      `📊 **Simulation Result:**`,
      `  ✅ Success: ${syncResult.simulation.success}`,
      `  🎯 Output: ${parseFloat(syncResult.simulation.outputAmount).toLocaleString()} ${operationType === 'buy' ? 'tokens' : 'SOL'}`,
      `  💸 Fees: ${syncResult.simulation.fees.totalFees.toFixed(6)} SOL`,
      `  ⏱️ Time: ${syncResult.simulation.responseTime}ms`,
      ``
    ]

    if (isRealTradeExecuted && syncResult.real) {
      lines.push(
        `🔥 **Real Trade Result:**`,
        `  ✅ Success: ${syncResult.real.success}`,
        `  🎯 Output: ${parseFloat(syncResult.real.outputAmount).toLocaleString()} ${operationType === 'buy' ? 'tokens' : 'SOL'}`,
        `  💸 Fees: ${syncResult.real.fees.totalFees.toFixed(6)} SOL`,
        `  ⏱️ Time: ${syncResult.real.responseTime}ms`,
      )

      // Add market cap, graduatedAt, and launchpad data
      if (tokenData) {
        if (tokenData.market_cap) {
          lines.push(`  📊 Market Cap: $${tokenData.market_cap.toLocaleString()}`)
        }
        if (tokenData.graduatedAt) {
          lines.push(`  🎓 Graduated: ${new Date(tokenData.graduatedAt).toLocaleDateString()}`)
        } else {
          console.log(`⚠️ No graduatedAt data for token: ${tokenSymbol || 'UNKNOWN'}`)
        }
        if (tokenData.launchpad) {
          lines.push(`  🚀 Launchpad: ${tokenData.launchpad}`)
        } else {
          console.log(`⚠️ No launchpad data for token: ${tokenSymbol || 'UNKNOWN'}`)
        }
      } else {
        console.log(`⚠️ No tokenData available for token: ${tokenSymbol || 'UNKNOWN'}`)
      }

      lines.push(``)

      console.warn('Real trade executed', lines)

      if (syncResult.real.signature) {
        lines.push(`🔗 Signature: \`${syncResult.real.signature}\``)
        lines.push(`📍 [View on Solscan](https://solscan.io/tx/${syncResult.real.signature})`)
        lines.push(``)
      }
    } else {
      lines.push(`💻 **Real Trade:** Not executed (simulation only)`, ``)
    }

    // Add deviation analysis if available
    if (syncResult.deviation && isRealTradeExecuted) {
      const deviation = syncResult.deviation
      const deviationEmoji = deviation.outputAmountDiffPercent > 5 ? '⚠️' : '✅'

      lines.push(
        `${deviationEmoji} **Synchronization Analysis:**`,
        `  📈 Output Deviation: ${deviation.outputAmountDiffPercent.toFixed(2)}%`,
        `  💰 Amount Diff: ${deviation.outputAmountDiff.toFixed(6)}`,
        `  💸 Fees Diff: ${deviation.feesDiff.toFixed(6)} SOL`,
        `  ⏱️ Time Diff: ${deviation.responseTimeDiff}ms`,
        ``
      )

      console.warn('Real trade executed with deviation', lines)

      // Add interpretation
      if (deviation.outputAmountDiffPercent > 10) {
        lines.push(`🚨 **HIGH DEVIATION DETECTED** - Investigate quote timing or slippage`)
      } else if (deviation.outputAmountDiffPercent > 5) {
        lines.push(`⚠️ **Moderate deviation** - Monitor for patterns`)
      } else {
        lines.push(`✅ **Good synchronization** - Results align well`)
      }
      lines.push(``)
    }

    lines.push(`⏰ ${formatAppDateTime(new Date())}`)

    const content = lines.join('\n')

    const fetchStartTime = Date.now()
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })

    const webhookResponseTime = Date.now() - fetchStartTime

    if (!response.ok) {
      const responseText = await response.text()
      throw new Error(`Discord webhook failed: ${response.status} ${response.statusText}\nResponse: ${responseText}`)
    }

    logTradeOperation('Discord Sync Notification Success', {
      tokenSymbol,
      operationType,
      isRealTradeExecuted,
      responseTime: webhookResponseTime,
      httpStatus: response.status
    })
  } catch (err) {
    logTradeOperation('Discord Sync Notification Error', {
      tokenSymbol: params.tokenSymbol,
      operationType: params.operationType,
      isRealTradeExecuted: params.isRealTradeExecuted
    }, err as Error)

    throw err
  }
}

// Discord notification for significant deviations summary
export async function sendSignificantDeviationsAlertDiscord(params: {
  tokenSymbol: string | null
  tokenAddress: string
  deviations: SyncedTradeResult[]
  operationType: 'buy' | 'sell'
}) {
  try {
    if (!shouldEnableNotifications()) {
      return
    }

    const { tokenSymbol, tokenAddress, deviations, operationType } = params

    logTradeOperation('Discord Significant Deviations Alert', {
      tokenSymbol,
      operationType,
      deviationCount: deviations.length
    })

    const lines = [
      `🚨 **SIGNIFICANT DEVIATIONS DETECTED**`,
      ``,
      `🪙 **${tokenSymbol || 'UNKNOWN'}** (${operationType.toUpperCase()})`,
      `📊 **${deviations.length} deviation(s) > 5%**`,
      ``
    ]

    // Add details for each significant deviation
    deviations.forEach((deviation, index) => {
      if (deviation.deviation && deviation.deviation.outputAmountDiffPercent > 5) {
        lines.push(
          `**Deviation ${index + 1}:**`,
          `  📈 Output Diff: ${deviation.deviation.outputAmountDiffPercent.toFixed(2)}%`,
          `  💰 Amount Diff: ${deviation.deviation.outputAmountDiff.toFixed(6)}`,
          `  💸 Fees Diff: ${deviation.deviation.feesDiff.toFixed(6)} SOL`,
          ``
        )
      }
    })

    // Add recommendations
    lines.push(
      `🔍 **Possible Causes:**`,
      `• Quote timing differences`,
      `• Network latency variations`,
      `• Slippage calculation differences`,
      `• Market volatility during execution`,
      ``,
      `💡 **Recommended Actions:**`,
      `• Review quote timing synchronization`,
      `• Check RPC latency patterns`,
      `• Monitor market conditions during trades`,
      ``,
      `⏰ ${formatAppDateTime(new Date())}`
    )

    const content = lines.join('\n')

    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })

    if (!response.ok) {
      throw new Error(`Discord webhook failed: ${response.status}`)
    }

    logTradeOperation('Discord Significant Deviations Alert Success', {
      tokenSymbol,
      operationType,
      deviationCount: deviations.length
    })
  } catch (err) {
    logTradeOperation('Discord Significant Deviations Alert Error', {
      tokenSymbol: params.tokenSymbol,
      operationType: params.operationType
    }, err as Error)
  }
}

// Helper function to determine notification status
export function getNotificationStatus(simulationStatus: TradingSimulationStatus): TradeAlertStatus {
  return simulationStatus === 'completed' ? 'completed' : 'partial-sell'
}
