/** Select-box sentinel — never send this to a swap API. */
export const AUTO_SLIPPAGE_BPS = -1
export const AUTO_SLIPPAGE_FLOOR_BPS = 20
export const AUTO_SLIPPAGE_BUFFER_BPS = 20
/** Hard ceiling so auto cannot open sandwich room. */
export const AUTO_SLIPPAGE_CAP_BPS = 150

export function isAutoSlippage(bps: number): boolean {
  return bps === AUTO_SLIPPAGE_BPS
}

/** `impactPct` is percent (1.2 = 1.2%). */
export function resolveAutoSlippageBps(
  impactPct: number | null | undefined,
): { ok: true; bps: number } | { ok: false; error: string } {
  const impactBps =
    impactPct == null || !Number.isFinite(impactPct)
      ? 0
      : Math.round(Math.abs(impactPct) * 100)
  if (impactBps > AUTO_SLIPPAGE_CAP_BPS) {
    return {
      ok: false,
      error: `Price impact ${impactBps} bps is above the auto cap (${AUTO_SLIPPAGE_CAP_BPS} bps). Cut size or set slippage manually.`,
    }
  }
  return {
    ok: true,
    bps: Math.min(
      AUTO_SLIPPAGE_CAP_BPS,
      Math.max(AUTO_SLIPPAGE_FLOOR_BPS, impactBps + AUTO_SLIPPAGE_BUFFER_BPS),
    ),
  }
}

/** True when quote impact is missing or above the auto cap (keep re-quoting). */
export function quoteIsVolatile(
  impacts: Array<number | null | undefined>,
): boolean {
  const worst = worstImpactPct(impacts)
  if (worst == null) return true
  return Math.round(worst * 100) > AUTO_SLIPPAGE_CAP_BPS
}

export function worstImpactPct(
  impacts: Array<number | null | undefined>,
): number | null {
  let worst: number | null = null
  for (const p of impacts) {
    if (p == null || !Number.isFinite(p)) continue
    const n = Math.abs(p)
    if (worst == null || n > worst) worst = n
  }
  return worst
}

/** Raptor/Kyber may send 0.012 or 1.2 for the same 1.2%. */
export function rawImpactToPct(raw: number): number {
  const a = Math.abs(raw)
  return a <= 1 ? a * 100 : a
}

/** Manual value, or auto from quote impact. Throws if auto is blocked by the cap. */
export function resolveTradeSlippageBps(
  selectedBps: number,
  impactPct: number | null | undefined,
): number {
  if (!isAutoSlippage(selectedBps)) return selectedBps
  const r = resolveAutoSlippageBps(impactPct)
  if (!r.ok) throw new Error(r.error)
  return r.bps
}

/** Prefetch/display quotes must not send the Auto sentinel to APIs. */
export function prefetchSlippageBps(selectedBps: number): number {
  return isAutoSlippage(selectedBps) ? AUTO_SLIPPAGE_FLOOR_BPS : selectedBps
}
