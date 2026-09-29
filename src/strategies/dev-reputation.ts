/**
 * Pure dev-reputation scorer — no IO.
 *
 * Input is GMGN created-tokens aggregate (+ optional Jupiter devMints / organicScore).
 * Total created = inner_count + open_count; the tokens[] array caps at 100, so we
 * score off the aggregate counts, never the array length.
 *
 * Shadow-first: `verdict` is advisory. A creator below DEV_MIN_SAMPLE is always
 * 'inconclusive' so a 1-coin dev never bans. Thresholds live in code, env-tunable.
 */

export type DevVerdict = 'ban' | 'good' | 'inconclusive' | 'unknown'

export type DevReputationInput = {
  innerCount: number
  openCount: number
  /** Creator's best-ever token ATH market cap (USD). */
  athMc?: number | null
  /** Jupiter `audit.devMints` — fallback sample when GMGN aggregates are absent. */
  mintedCount?: number | null
  /** Per-coin ATHs (USD), used to derive athMc when the aggregate is missing. */
  tokenAthMcs?: Array<number | null>
}

export type DevReputation = {
  sample: number
  openCount: number
  innerCount: number
  graduationRatio: number | null
  athMc: number | null
  verdict: DevVerdict
  reasons: string[]
}

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function finite(...values: Array<number | null | undefined>): number | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

export function scoreDevReputation(input: DevReputationInput): DevReputation {
  const innerCount = Math.max(0, Math.floor(input.innerCount || 0))
  const openCount = Math.max(0, Math.floor(input.openCount || 0))
  const aggregateSample = innerCount + openCount
  const minted = Math.max(0, Math.floor(input.mintedCount ?? 0))
  const sample = aggregateSample > 0 ? aggregateSample : minted

  const graduationRatio = sample > 0 ? openCount / sample : null

  const bestFromList = (input.tokenAthMcs ?? []).reduce<number | null>(
    (best, v) => {
      const n = finite(v)
      if (n == null) return best
      return best == null || n > best ? n : best
    },
    null,
  )
  const athMc = finite(input.athMc, bestFromList)

  const minSample = envNum('DEV_MIN_SAMPLE', 5)
  const banMaxGrad = envNum('DEV_BAN_MAX_GRADUATION', 0.05)
  const goodMinGrad = envNum('DEV_GOOD_MIN_GRADUATION', 0.25)
  const goodMinAth = envNum('DEV_GOOD_MIN_ATH_MC', 1_000_000)

  const base = { sample, openCount, innerCount, graduationRatio, athMc }

  if (sample < minSample || graduationRatio == null) {
    return {
      ...base,
      verdict: 'inconclusive',
      reasons: [`sample ${sample} < min ${minSample}`],
    }
  }

  const reasons: string[] = [
    `created ${sample} (${openCount} graduated, ${(graduationRatio * 100).toFixed(1)}%)`,
  ]

  if (graduationRatio >= goodMinGrad && athMc != null && athMc >= goodMinAth) {
    reasons.push(`ath $${Math.round(athMc).toLocaleString('en-US')} ≥ $${goodMinAth}`)
    return { ...base, verdict: 'good', reasons }
  }

  if (graduationRatio <= banMaxGrad) {
    reasons.push(`graduation ≤ ${(banMaxGrad * 100).toFixed(0)}% (serial launcher)`)
    return { ...base, verdict: 'ban', reasons }
  }

  reasons.push('between ban and good bands')
  return { ...base, verdict: 'inconclusive', reasons }
}
