import type { SocialGateConfig } from '@/strategies/types'

export type { SocialGateConfig }

export type SocialEventType = 'mention' | 'wallet_buy' | 'wallet_sell'

export type TrackedWalletRow = {
  address: string
  label: string
  tier: 'tier1' | 'tier2'
  tags: string[]
  is_active: boolean
  last_polled_at: string | null
  last_poll_error: string | null
  created_at: string
  updated_at: string
}

export type SocialTokenEventRow = {
  id: string
  token_address: string
  event_type: SocialEventType
  source: string
  channel_id: string | null
  channel_label: string | null
  wallet_address: string | null
  wallet_label: string | null
  external_message_id: string | null
  occurred_at: string
  raw_metadata: Record<string, unknown>
  created_at: string
}

export type SocialTokenRollupRow = {
  token_address: string
  first_seen_at: string | null
  first_source: string | null
  first_channel: string | null
  mention_count_5m: number
  mention_count_30m: number
  mention_count_24h: number
  unique_channel_count_30m: number
  smart_wallet_buy_count_1h: number
  smart_wallet_buy_sol_1h: number
  top_source: string | null
  last_event_at: string | null
  updated_at: string
}

export type SocialSnapshot = {
  telegram_mention_count_5m: number
  telegram_mention_count_30m: number
  telegram_unique_channels_30m: number
  minutes_since_first_mention: number | null
  smart_wallet_buy_count_1h: number
  smart_wallet_buy_sol_1h: number
  telegram_top_source: string | null
  has_smart_wallet_buy: boolean
}

export type SocialIngestEvent = {
  token_address: string
  event_type: SocialEventType
  source: string
  channel_id?: string | null
  channel_label?: string | null
  wallet_address?: string | null
  wallet_label?: string | null
  external_message_id?: string | null
  occurred_at?: string
  raw_metadata?: Record<string, unknown>
}

export const EMPTY_SOCIAL_SNAPSHOT: SocialSnapshot = {
  telegram_mention_count_5m: 0,
  telegram_mention_count_30m: 0,
  telegram_unique_channels_30m: 0,
  minutes_since_first_mention: null,
  smart_wallet_buy_count_1h: 0,
  smart_wallet_buy_sol_1h: 0,
  telegram_top_source: null,
  has_smart_wallet_buy: false,
}
