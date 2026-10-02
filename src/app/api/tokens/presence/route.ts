import { NextRequest, NextResponse } from 'next/server'
import { loadTrackerSocialJoinMap } from '@/app/api/mcap-tracking/join-trending-social'
import type { TrackerSocialLinks } from '@/utils/tracker-social-join'
import { isTrackerSocialJoinEnabled } from '@/utils/tracker-flags'
import { isValidMintAddress } from '@/utils/jupiter'

/**
 * Batch web/social presence for the /dev/signals token lists.
 *
 * Sol-only: the join source (GMGN rank feed) and the standing product scope are
 * both sol, so non-sol mints are dropped rather than half-served.
 *
 * Nothing is persisted — presence exists only for mints currently in GMGN's rank
 * feed (Redis 2–5 min). Absent is a normal answer, never an error.
 */

export const MAX_PRESENCE_MINTS = 200

/** Trim, dedupe, drop non-sol mints, cap. Exported for the unit test. */
export function parsePresenceMints(
  raw: string | null | undefined,
  cap: number = MAX_PRESENCE_MINTS,
): string[] {
  if (!raw) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const mint = part.trim()
    if (!mint || seen.has(mint)) continue
    if (!isValidMintAddress(mint)) continue
    seen.add(mint)
    out.push(mint)
    if (out.length >= cap) break
  }
  return out
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const

export async function GET(request: NextRequest) {
  const empty = NextResponse.json({ success: true, presence: {} }, { headers: NO_STORE })
  if (!isTrackerSocialJoinEnabled()) return empty

  const mints = parsePresenceMints(request.nextUrl.searchParams.get('mints'))
  if (mints.length === 0) return empty

  try {
    const join = await loadTrackerSocialJoinMap({ chain: 'sol' })
    const presence: Record<string, TrackerSocialLinks> = {}
    for (const mint of mints) {
      const social = join.get(mint)?.social
      if (social) presence[mint] = social
    }
    return NextResponse.json({ success: true, presence }, { headers: NO_STORE })
  } catch {
    // A missing presence row must never break a list.
    return empty
  }
}
