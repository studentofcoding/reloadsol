const BASE58_CA = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g
const PUMP_SUFFIX = /\/([^/\s]*pump)\s*$/m

export type ParsedTelegramAlert = {
  token_address: string
  token_name: string | null
  token_symbol: string | null
  signal_price_usd: number
  signal_pct_change: number | null
  market_cap_usd: number | null
  dex: string | null
  buy_sol_3m: number | null
}

function parseMcapValue(raw: string, suffix?: string): number | null {
  const num = parseFloat(raw)
  if (!Number.isFinite(num)) return null
  const s = (suffix ?? '').toUpperCase()
  if (s === 'K') return num * 1_000
  if (s === 'M') return num * 1_000_000
  if (s === 'B') return num * 1_000_000_000
  return num
}

function extractTokenAddress(text: string): string | null {
  const pumpMatch = PUMP_SUFFIX.exec(text)
  if (pumpMatch?.[1] && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pumpMatch[1])) {
    return pumpMatch[1]
  }

  const matches = text.match(BASE58_CA) ?? []
  for (const ca of matches) {
    if (ca.endsWith('pump')) return ca
  }
  return matches[0] ?? null
}

function parseTitleLine(text: string): { token_name: string | null; token_symbol: string | null } {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  if (!firstLine) return { token_name: null, token_symbol: null }

  const symbolMatch = firstLine.match(/\(([^)]+)\)/)
  const token_symbol = symbolMatch?.[1]?.trim() || null

  let token_name = firstLine
  if (symbolMatch?.index != null) {
    token_name = firstLine.slice(0, symbolMatch.index).trim()
  }
  token_name = token_name.replace(/\s*NEW\s+ALERT.*$/i, '').trim()

  return {
    token_name: token_name || null,
    token_symbol,
  }
}

/** Parses coin/message fields only — channel name is supplied separately. */
export function parseTelegramAlert(rawMessage: string): ParsedTelegramAlert | null {
  const text = rawMessage?.trim()
  if (!text) return null

  const token_address = extractTokenAddress(text)
  if (!token_address) return null

  const priceMatch = text.match(/USD:\s*\$([\d.]+)/i)
  if (!priceMatch) return null
  const signal_price_usd = parseFloat(priceMatch[1])
  if (!Number.isFinite(signal_price_usd) || signal_price_usd <= 0) return null

  const pctMatch = text.match(/USD:\s*\$[\d.]+\s*\(\+?(-?\d+(?:\.\d+)?)%\)/i)
  const signal_pct_change = pctMatch ? parseFloat(pctMatch[1]) : null

  const mcapMatch = text.match(/MC:\s*\$([\d.]+)\s*(K|M|B)?/i)
  const market_cap_usd = mcapMatch
    ? parseMcapValue(mcapMatch[1], mcapMatch[2])
    : null

  const dexMatch = text.match(/Dex:\s*(\S+)/i)
  const dex = dexMatch?.[1]?.trim() || null

  const buyMatch = text.match(/Last\s+3\s+mins\s+buy:\s*([\d.]+)\s*SOL/i)
  const buy_sol_3m = buyMatch ? parseFloat(buyMatch[1]) : null

  const { token_name, token_symbol } = parseTitleLine(text)

  return {
    token_address,
    token_name,
    token_symbol,
    signal_price_usd,
    signal_pct_change: Number.isFinite(signal_pct_change ?? NaN) ? signal_pct_change : null,
    market_cap_usd,
    dex,
    buy_sol_3m: Number.isFinite(buy_sol_3m ?? NaN) ? buy_sol_3m : null,
  }
}

export const BLACK_COBRA_ALERT_EXAMPLE = `The Black Cobra (TATE) NEW ALERT!!!
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨
Last 3 mins buy:  54 SOL in 23 buys

oVDNWQ6ZPQEPp9hcP6WheeacZncyy7ubHrwnKGDpump
USD: $0.0000679 (+34%)
Dex: PumpSwap
MC:  $70.3K | ⌛️ 19s
Vol: $23.0K | 1H: +25% 🅑 81 🅢 38`
