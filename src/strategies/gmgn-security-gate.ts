import type { GmgnStrategyConfig, GmgnVerdictLevel } from './types'

export type GmgnSecurityVerdict = {
  pass: boolean
  verdict: GmgnVerdictLevel
  reasons: string[]
  features: Record<string, unknown>
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function readBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'yes') return true
  if (value === 0 || value === '0' || value === 'no') return false
  return null
}

function readNested(
  root: Record<string, unknown>,
  path: string[],
): unknown {
  let cur: unknown = root
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

function isHoneypot(security: Record<string, unknown>): boolean {
  if (security.is_honeypot === 'yes' || security.honeypot === 1) return true
  return false
}

function creatorClosed(info: Record<string, unknown>, security: Record<string, unknown>): boolean {
  const devStatus = readNested(info, ['dev', 'creator_token_status'])
  const secStatus = security.creator_token_status
  if (devStatus === 'creator_close' || devStatus === 'sell') return true
  if (secStatus === 'creator_close') return true
  return false
}

function verdictRank(v: GmgnVerdictLevel): number {
  if (v === 'clean') return 0
  if (v === 'mixed') return 1
  return 2
}

export function evaluateGmgnSecurity(params: {
  tokenAddress: string
  chain: string
  info: Record<string, unknown>
  security: Record<string, unknown>
  config: GmgnStrategyConfig['security']
}): GmgnSecurityVerdict {
  const { info, security, config } = params
  const reasons: string[] = []
  let danger = 0
  let warning = 0

  const symbol =
    typeof info.symbol === 'string'
      ? info.symbol
      : params.tokenAddress.slice(0, 8)
  const priceStr = readNested(info, ['price', 'price'])
  const priceUsd = readNumber(priceStr)
  const circulating = readNumber(info.circulating_supply)
  const marketCapUsd =
    priceUsd != null && circulating != null ? priceUsd * circulating : null
  const liquidity = readNumber(info.liquidity)
  const top10 =
    readNumber(security.top_10_holder_rate) ??
    readNumber(readNested(info, ['stat', 'top_10_holder_rate'])) ??
    readNumber(readNested(info, ['dev', 'top_10_holder_rate']))
  const rugRatio = readNumber(security.rug_ratio)
  const smartWallets = readNumber(readNested(info, ['wallet_tags_stat', 'smart_wallets']))
  const sniperWallets = readNumber(readNested(info, ['wallet_tags_stat', 'sniper_wallets']))
  const renouncedMint = readBool(security.renounced_mint)
  const renouncedFreeze = readBool(security.renounced_freeze_account)
  const devClosed = creatorClosed(info, security)

  const features: Record<string, unknown> = {
    token_symbol: symbol,
    gmgn_price_usd: priceUsd,
    gmgn_market_cap_usd: marketCapUsd,
    gmgn_liquidity_usd: liquidity,
    gmgn_top_10_holder_rate: top10,
    gmgn_rug_ratio: rugRatio,
    gmgn_smart_wallets: smartWallets,
    gmgn_sniper_wallets: sniperWallets,
    gmgn_renounced_mint: renouncedMint,
    gmgn_renounced_freeze: renouncedFreeze,
    gmgn_creator_closed: devClosed,
    gmgn_holder_count: readNumber(info.holder_count),
    gmgn_renowned_wallets: readNumber(readNested(info, ['wallet_tags_stat', 'renowned_wallets'])),
    gmgn_launchpad: info.launchpad ?? null,
  }

  if (!config.enabled) {
    return { pass: true, verdict: 'clean', reasons: ['security gate disabled'], features }
  }

  if (isHoneypot(security)) {
    danger++
    reasons.push('honeypot detected')
  }

  if (config.requireRenouncedMint && renouncedMint !== true) {
    danger++
    reasons.push('mint not renounced')
  }

  if (config.requireRenouncedFreeze && renouncedFreeze !== true) {
    danger++
    reasons.push('freeze authority not renounced')
  }

  if (config.requireCreatorClosed && !devClosed) {
    danger++
    reasons.push('creator still holding')
  }

  if (top10 != null && top10 > config.maxTop10HolderRate) {
    danger++
    reasons.push(`top-10 holders ${(top10 * 100).toFixed(1)}% > ${(config.maxTop10HolderRate * 100).toFixed(0)}%`)
  }

  if (rugRatio != null && rugRatio > config.maxRugRatio) {
    danger++
    reasons.push(`rug ratio ${rugRatio.toFixed(2)} > ${config.maxRugRatio}`)
  }

  if (liquidity != null && liquidity < config.minLiquidityUsd) {
    warning++
    reasons.push(`liquidity $${liquidity.toFixed(0)} < $${config.minLiquidityUsd}`)
  }

  if (smartWallets != null && smartWallets < config.minSmartWallets) {
    warning++
    reasons.push(`smart wallets ${smartWallets} < ${config.minSmartWallets}`)
  }

  if (sniperWallets != null && sniperWallets > config.maxSniperCount) {
    warning++
    reasons.push(`sniper wallets ${sniperWallets} > ${config.maxSniperCount}`)
  }

  let verdict: GmgnVerdictLevel = 'clean'
  if (danger > 0) {
    verdict = 'reject'
  } else if (warning >= 3) {
    verdict = 'mixed'
  } else if (warning > 0) {
    verdict = 'mixed'
  }

  const pass = verdictRank(verdict) <= verdictRank(config.minVerdict)

  return { pass, verdict, reasons, features }
}
