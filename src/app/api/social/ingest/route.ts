import { NextRequest, NextResponse } from 'next/server'
import { insertSocialEvents } from '@/strategies/social/db'
import type { SocialIngestEvent } from '@/strategies/social/types'
import { isSocialIngestAuthorized } from '@/utils/social/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

function parseEvents(body: unknown): SocialIngestEvent[] | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Invalid JSON body' }
  const raw = (body as { events?: unknown }).events
  if (!Array.isArray(raw)) return { error: 'Expected { events: [...] }' }

  const events: SocialIngestEvent[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const token = typeof row.token_address === 'string' ? row.token_address.trim() : ''
    const source = typeof row.source === 'string' ? row.source.trim() : ''
    const eventType = row.event_type
    if (!BASE58.test(token) || !source) continue
    if (eventType !== 'mention' && eventType !== 'wallet_buy' && eventType !== 'wallet_sell') {
      continue
    }
    events.push({
      token_address: token,
      event_type: eventType,
      source,
      channel_id: typeof row.channel_id === 'string' ? row.channel_id : null,
      channel_label: typeof row.channel_label === 'string' ? row.channel_label : null,
      wallet_address:
        typeof row.wallet_address === 'string' && BASE58.test(row.wallet_address)
          ? row.wallet_address
          : null,
      wallet_label: typeof row.wallet_label === 'string' ? row.wallet_label : null,
      external_message_id:
        typeof row.external_message_id === 'string' ? row.external_message_id : null,
      occurred_at: typeof row.occurred_at === 'string' ? row.occurred_at : undefined,
      raw_metadata:
        row.raw_metadata && typeof row.raw_metadata === 'object'
          ? (row.raw_metadata as Record<string, unknown>)
          : {},
    })
  }

  if (events.length === 0) return { error: 'No valid events in payload' }
  return events
}

export async function POST(request: NextRequest) {
  const key =
    request.nextUrl.searchParams.get('key') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')

  if (!isSocialIngestAuthorized(key)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const parsed = parseEvents(body)
    if ('error' in parsed) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 })
    }

    const result = await insertSocialEvents(parsed)
    return NextResponse.json({
      success: true,
      received: parsed.length,
      ...result,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
