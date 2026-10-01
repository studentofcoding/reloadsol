/**
 * Token-2022 transfer-fee awareness for swap slippage.
 *
 * A Token-2022 mint can charge a transfer fee on every transfer. That fee is invisible to a slippage
 * figure derived from quoted price impact — `resolveAutoSlippageBps` floors at 20 bps, while DEW's fee
 * alone is 100 bps. Measured: at `slippageBps=100` the router's own post-check fails with
 * `6001 SlippageToleranceExceeded` and the transaction can never land; the identical route at 300 bps
 * simulates cleanly.
 *
 * So: read the mint's own `transferFeeConfig` once (cached), and never quote below fee + margin.
 *
 * Fail-open by design — if the mint cannot be read we return 0 and the swap proceeds on the caller's
 * slippage, exactly as before. A failed lookup must not block a trade.
 */
import { getPrimaryRpcUrl } from '@/utils/rpc-urls'

export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

/** Headroom above the raw fee, so the fee alone does not consume the whole budget. */
export const SWAP_TRANSFER_FEE_MARGIN_BPS_DEFAULT = 30
export const TRANSFER_FEE_CACHE_MS_DEFAULT = 10 * 60 * 1000

export function getTransferFeeMarginBps(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.SWAP_TRANSFER_FEE_MARGIN_BPS)
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : SWAP_TRANSFER_FEE_MARGIN_BPS_DEFAULT
}

function resolveCacheMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.SWAP_TRANSFER_FEE_CACHE_MS)
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : TRANSFER_FEE_CACHE_MS_DEFAULT
}

function feeBpsOf(node: unknown): number | null {
  if (!node || typeof node !== 'object') return null
  const bps = (node as { transferFeeBasisPoints?: unknown }).transferFeeBasisPoints
  return typeof bps === 'number' && Number.isFinite(bps) && bps >= 0 ? bps : null
}

/**
 * Basis points in force at `epoch`, from a `jsonParsed` mint's `transferFeeConfig` extension.
 * Token-2022 stores an older and a newer config; the newer one applies from its own epoch on.
 * Tolerates both the nested (`{transferFeeConfig: {...}}`) and flat shapes the RPC emits.
 */
export function transferFeeBpsFromMintAccount(
  account: unknown,
  epoch: number,
): number {
  const info = (account as { data?: { parsed?: { info?: Record<string, unknown> } } })?.data
    ?.parsed?.info
  if (!info) return 0

  const extensions = info.extensions
  if (!Array.isArray(extensions)) return 0

  const entry = extensions.find(
    (e) => (e as { extension?: string })?.extension === 'transferFeeConfig',
  )
  if (!entry) return 0

  const raw = (entry as { state?: unknown }).state
  const state =
    raw && typeof raw === 'object' && 'transferFeeConfig' in (raw as object)
      ? (raw as { transferFeeConfig?: unknown }).transferFeeConfig
      : raw
  if (!state || typeof state !== 'object') return 0

  const { olderTransferFee, newerTransferFee } = state as {
    olderTransferFee?: unknown
    newerTransferFee?: unknown
  }

  const newerEpoch = (newerTransferFee as { epoch?: unknown })?.epoch
  if (
    typeof newerEpoch === 'number' &&
    Number.isFinite(newerEpoch) &&
    epoch >= newerEpoch
  ) {
    const bps = feeBpsOf(newerTransferFee)
    if (bps != null) return bps
  }

  return feeBpsOf(olderTransferFee) ?? 0
}

/** Raise `slippageBps` so a transfer fee never eats the whole tolerance. Never lowers it. */
export function applyTransferFeeFloor(
  slippageBps: number,
  feeBps: number,
  marginBps: number = SWAP_TRANSFER_FEE_MARGIN_BPS_DEFAULT,
): number {
  if (!Number.isFinite(slippageBps) || slippageBps <= 0) return slippageBps
  if (!Number.isFinite(feeBps) || feeBps <= 0) return slippageBps
  const floor = Math.ceil(feeBps) + Math.max(0, Math.floor(marginBps))
  return Math.max(slippageBps, floor)
}

type CacheRow = { bps: number; at: number }
const cache = new Map<string, CacheRow>()

export function resetTransferFeeCacheForTests(): void {
  cache.clear()
}

function rpcUrlForRead(): string | null {
  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_RPC_URL?.split(',')[0]?.trim() || null
  }
  try {
    return getPrimaryRpcUrl()
  } catch {
    return null
  }
}

/**
 * Transfer fee in basis points for `mint`. `0` when it is not a Token-2022 mint, carries no fee, or
 * cannot be read. Cached — a mint's fee schedule changes at most once per epoch.
 */
export async function getTransferFeeBps(
  mint: string,
  options?: { timeoutMs?: number; skipCache?: boolean },
): Promise<number> {
  const cached = cache.get(mint)
  if (!options?.skipCache && cached && Date.now() - cached.at < resolveCacheMs()) {
    return cached.bps
  }

  const url = rpcUrlForRead()
  if (!url) return 0

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 1500)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [mint, { encoding: 'jsonParsed' }],
      }),
      signal: controller.signal,
    })
    const body = (await response.json()) as {
      result?: { value?: { owner?: string; data?: unknown }; context?: { slot?: number } }
    }
    const value = body?.result?.value
    if (!value || value.owner !== TOKEN_2022_PROGRAM_ID) {
      cache.set(mint, { bps: 0, at: Date.now() })
      return 0
    }

    // The fee schedule is keyed to an epoch; `getEpochInfo` is one more round trip, so the slot's
    // epoch is approximated from the account read itself and the newer config is used when its epoch
    // has already passed. Erring toward the older (lower) figure is safe: margin covers the gap.
    const epoch = await currentEpoch(url, controller.signal)
    const bps = transferFeeBpsFromMintAccount(value, epoch)
    cache.set(mint, { bps, at: Date.now() })
    return bps
  } catch {
    return 0
  } finally {
    clearTimeout(timer)
  }
}

async function currentEpoch(url: string, signal: AbortSignal): Promise<number> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getEpochInfo', params: [] }),
      signal,
    })
    const body = (await response.json()) as { result?: { epoch?: number } }
    return typeof body?.result?.epoch === 'number' ? body.result.epoch : 0
  } catch {
    return 0
  }
}

/**
 * Effective slippage for a swap: the caller's figure raised to cover a transfer fee. Returns the
 * slippage unchanged for every classic SPL mint (the overwhelming majority) at one cached lookup.
 */
export async function withTransferFeeFloor(
  inputMint: string,
  slippageBps: number,
  env: Record<string, string | undefined> = process.env,
): Promise<{ slippageBps: number; feeBps: number }> {
  const feeBps = await getTransferFeeBps(inputMint)
  const floored = applyTransferFeeFloor(
    slippageBps,
    feeBps,
    getTransferFeeMarginBps(env),
  )
  return { slippageBps: floored, feeBps }
}
