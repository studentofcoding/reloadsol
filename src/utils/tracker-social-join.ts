/** Fields we can join from GMGN filtered trending or Jupiter/trending. */
export type TrendingSocialFields = {
  token_address?: string
  twitter?: string
  telegram?: string
  website?: string
  organic_score?: number | null
  logo_url?: string | null
}

export type TrackerSocialLinks = {
  twitter?: string
  telegram?: string
  website?: string
}

export type TrackerSocialEnrichment = {
  social?: TrackerSocialLinks
  organic_score?: number | null
  logo_url?: string | null
}

function pickStr(v?: string | null): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function pickOrganic(v?: number | null): number | null {
  return v != null && Number.isFinite(v) ? v : null
}

/** Map one trending row onto the Tracker list social payload. */
export function mapTrackerSocialFromTrending(
  row: TrendingSocialFields,
): TrackerSocialEnrichment {
  const twitter = pickStr(row.twitter)
  const telegram = pickStr(row.telegram)
  const website = pickStr(row.website)
  const social =
    twitter || telegram || website
      ? { ...(twitter ? { twitter } : {}), ...(telegram ? { telegram } : {}), ...(website ? { website } : {}) }
      : undefined
  return {
    social,
    organic_score: pickOrganic(row.organic_score),
    logo_url: pickStr(row.logo_url) ?? null,
  }
}

/**
 * Source priority (SPEC):
 * twitter/telegram/website — GMGN filtered map, then Jupiter/trending
 * organic_score — Jupiter trending when present, else GMGN
 * logo_url — trending when present (Jupiter, then GMGN)
 */
export function mergeTrackerSocialSources(
  gmgn?: TrendingSocialFields | null,
  jupiter?: TrendingSocialFields | null,
): TrackerSocialEnrichment {
  const g = gmgn ? mapTrackerSocialFromTrending(gmgn) : { organic_score: null, logo_url: null }
  const j = jupiter
    ? mapTrackerSocialFromTrending(jupiter)
    : { organic_score: null, logo_url: null }
  const twitter = g.social?.twitter ?? j.social?.twitter
  const telegram = g.social?.telegram ?? j.social?.telegram
  const website = g.social?.website ?? j.social?.website
  const social =
    twitter || telegram || website
      ? { ...(twitter ? { twitter } : {}), ...(telegram ? { telegram } : {}), ...(website ? { website } : {}) }
      : undefined
  const organic_score =
    j.organic_score != null ? j.organic_score : (g.organic_score ?? null)
  const logo_url = j.logo_url || g.logo_url || null
  return { social, organic_score, logo_url }
}

export function buildTrackerSocialJoinMap(
  gmgnRows: TrendingSocialFields[],
  jupiterRows: TrendingSocialFields[] = [],
): Map<string, TrackerSocialEnrichment> {
  const gmgnMap = new Map<string, TrendingSocialFields>()
  for (const row of gmgnRows) {
    const addr = pickStr(row.token_address)
    if (addr) gmgnMap.set(addr, row)
  }
  const jupMap = new Map<string, TrendingSocialFields>()
  for (const row of jupiterRows) {
    const addr = pickStr(row.token_address)
    if (addr) jupMap.set(addr, row)
  }
  const out = new Map<string, TrackerSocialEnrichment>()
  const keys = new Set([...gmgnMap.keys(), ...jupMap.keys()])
  for (const key of keys) {
    out.set(key, mergeTrackerSocialSources(gmgnMap.get(key), jupMap.get(key)))
  }
  return out
}
