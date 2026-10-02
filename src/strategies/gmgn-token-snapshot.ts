export type GmgnTokenSnapshot = {
  top10HoldPct: number | null
  devHoldPct: number | null
  snipersHoldPct: number | null
  sniperWalletCount: number | null
  freezeAuthActive: boolean | null
  mintAuthActive: boolean | null
  dexBoostLabel: string | null
  proTradersPct: number | null
  insidersHoldPct: number | null
  bundlersHoldPct: number | null
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
  if (value === 1 || value === '1' || value === 'yes' || value === 'true') {
    return true
  }
  if (value === 0 || value === '0' || value === 'no' || value === 'false') {
    return false
  }
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

/** GMGN rates are usually 0–1; some fields already percent. */
function asPercent(rate: number | null): number | null {
  if (rate == null) return null
  if (rate > 1 && rate <= 100) return rate
  return rate * 100
}

function formatDexBoost(info: Record<string, unknown>): string | null {
  const fee = readNumber(readNested(info, ['dev', 'dexscr_boost_fee']))
  const ts = readNumber(readNested(info, ['dev', 'dexscr_boost_ts']))
  const used =
    fee != null && fee > 0
      ? true
      : readBool(readNested(info, ['dev', 'dexscr_boost_fee'])) === true
  if (!used && (ts == null || ts <= 0)) return null
  if (ts != null && ts > 0) {
    const ageH = Math.max(0, (Date.now() / 1000 - ts) / 3600)
    if (ageH < 1) return 'Boost <1h'
    if (ageH < 48) return `Boost ${Math.round(ageH)}h`
    return `Boost ${Math.round(ageH / 24)}d`
  }
  return 'Boost'
}

/**
 * Flatten GMGN token info + security into Freeview 9-tile snapshot.
 * Freeze/Mint: renounced=true → auth inactive → display "No".
 */
export function buildGmgnTokenSnapshot(
  info: Record<string, unknown>,
  security: Record<string, unknown>,
): GmgnTokenSnapshot {
  const top10 = asPercent(
    readNumber(security.top_10_holder_rate) ??
      readNumber(readNested(info, ['stat', 'top_10_holder_rate'])) ??
      readNumber(readNested(info, ['dev', 'top_10_holder_rate'])),
  )

  const devHoldRaw = asPercent(
    readNumber(security.creator_balance_rate) ??
      readNumber(readNested(info, ['stat', 'creator_hold_rate'])) ??
      readNumber(readNested(info, ['stat', 'dev_team_hold_rate'])),
  )
  // A 0 is a measurement ("dev sold out"), never a default. No source key → null (above). A 0 that
  // contradicts GMGN's own `creator_token_status: 'creator_hold'` is an unfilled field, not a 0.
  const creatorStatus =
    typeof security.creator_token_status === 'string'
      ? security.creator_token_status
      : typeof readNested(info, ['dev', 'creator_token_status']) === 'string'
        ? (readNested(info, ['dev', 'creator_token_status']) as string)
        : null
  const devHold =
    devHoldRaw === 0 && creatorStatus === 'creator_hold' ? null : devHoldRaw

  const snipersHold = asPercent(
    readNumber(security.sniper_hold_rate) ??
      readNumber(security.top_sniper_hold_rate) ??
      readNumber(readNested(info, ['stat', 'sniper_hold_rate'])),
  )
  const sniperWalletCount =
    readNumber(security.sniper_count) ??
    readNumber(readNested(info, ['wallet_tags_stat', 'sniper_wallets']))

  const renouncedFreeze = readBool(security.renounced_freeze_account)
  const renouncedMint = readBool(security.renounced_mint)
  // Active auth = not renounced
  const freezeAuthActive =
    renouncedFreeze == null ? null : renouncedFreeze === false
  const mintAuthActive =
    renouncedMint == null ? null : renouncedMint === false

  const proTraders = asPercent(
    readNumber(security.pro_trader_hold_rate) ??
      readNumber(readNested(info, ['stat', 'pro_trader_hold_rate'])) ??
      readNumber(readNested(info, ['stat', 'smart_degen_hold_rate'])) ??
      readNumber(readNested(info, ['stat', 'bot_degen_rate'])),
  )

  // `suspected_insider_hold_rate` only exists on the GMGN OpenAPI security payload; the web
  // multi endpoints never carry it, which is why this tile was NULL on every ledger row. GMGN's
  // "Insiders" is the rat-trader share (`rat_trader_amount_rate` / `top_rat_trader_percentage`) —
  // the same volume-share family the bundlers tile already reads — so it is the fallback.
  const insiders = asPercent(
    readNumber(security.suspected_insider_hold_rate) ??
      readNumber(readNested(info, ['stat', 'suspected_insider_hold_rate'])) ??
      readNumber(security.rat_trader_amount_rate) ??
      readNumber(readNested(info, ['stat', 'top_rat_trader_percentage'])) ??
      readNumber(readNested(info, ['stat', 'rat_trader_amount_rate'])),
  )

  const bundlers = asPercent(
    readNumber(security.bundler_trader_amount_rate) ??
      readNumber(readNested(info, ['stat', 'top_bundler_trader_percentage'])),
  )

  return {
    top10HoldPct: top10,
    devHoldPct: devHold,
    snipersHoldPct: snipersHold,
    sniperWalletCount,
    freezeAuthActive,
    mintAuthActive,
    dexBoostLabel: formatDexBoost(info),
    proTradersPct: proTraders,
    insidersHoldPct: insiders,
    bundlersHoldPct: bundlers,
  }
}

/**
 * The tiles a ledger row must carry before it may occupy the write-once key: top-10, snipers,
 * bundlers and both authority flags. A panel missing any of them (an upstream partial, or a cached
 * mint-only fetch) would be frozen forever. Dev / insiders / pro-traders / boost may legitimately be
 * unknown and are not required.
 */
export function missingCoreTiles(snapshot: GmgnTokenSnapshot): string[] {
  const missing: string[] = []
  if (snapshot.top10HoldPct == null) missing.push('top10HoldPct')
  if (snapshot.snipersHoldPct == null) missing.push('snipersHoldPct')
  if (snapshot.bundlersHoldPct == null) missing.push('bundlersHoldPct')
  if (snapshot.freezeAuthActive == null) missing.push('freezeAuthActive')
  if (snapshot.mintAuthActive == null) missing.push('mintAuthActive')
  return missing
}
