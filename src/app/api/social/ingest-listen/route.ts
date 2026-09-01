import { NextRequest, NextResponse, connection } from 'next/server'
import { getMergedSocialRegistry } from '@/strategies/load-social'
import { isSocialIngestAuthorized } from '@/utils/social/config'


export type IngestListenChannel = {
  source: string
  peer: string
}

/** First non-empty peer per source; prefer active strategies, then inactive. */
export function collectListenChannelPeers(
  registry: Record<
    string,
    { is_active: boolean; config: { entry: { listenChannelPeers?: Record<string, string> } } }
  >,
): IngestListenChannel[] {
  const peers = new Map<string, string>()

  const apply = (activeOnly: boolean) => {
    for (const strategy of Object.values(registry)) {
      if (activeOnly && !strategy.is_active) continue
      if (!activeOnly && strategy.is_active) continue
      const map = strategy.config.entry.listenChannelPeers ?? {}
      for (const [source, raw] of Object.entries(map)) {
        const peer = raw.trim()
        const key = source.trim()
        if (!key || !peer || peers.has(key)) continue
        peers.set(key, peer)
      }
    }
  }

  apply(true)
  apply(false)

  return Array.from(peers.entries())
    .map(([source, peer]) => ({ source, peer }))
    .sort((a, b) => a.source.localeCompare(b.source))
}

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  await connection()
  const key = request.nextUrl.searchParams.get('key')
  if (!isSocialIngestAuthorized(key)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const registry = await getMergedSocialRegistry()
    const channels = collectListenChannelPeers(registry)
    return NextResponse.json({ success: true, channels })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to load ingest listen channels',
      },
      { status: 500 },
    )
  }
}
