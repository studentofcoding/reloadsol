/** Shared USD / APR display for dense DLMM pool tables. */

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${Math.round(n).toLocaleString()}`
  return `$${n.toFixed(0)}`
}

export function formatApr(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—'
  if (pct > 9999) return '>9,999%'
  if (pct >= 100) return `${Math.round(pct)}%`
  return `${pct.toFixed(1)}%`
}
