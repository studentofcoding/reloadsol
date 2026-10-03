import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({ query: vi.fn(async () => ({ rows: [] })) }))
vi.mock('@/utils/gmgn-web-multi', () => ({
  enqueueGmgnWebLedgerMints: vi.fn(),
  markGmgnWebLedgerCaptured: vi.fn(),
  usesGmgnWebTokenInfo: vi.fn(() => false),
}))
vi.mock('@/utils/gmgn-snapshot-cache', () => ({ getGmgnTokenSnapshotCached: vi.fn() }))
vi.mock('@/strategies/risk-shadow-queue', () => ({ enqueueRiskShadow: vi.fn() }))
vi.mock('@/strategies/token-entry-context', () => ({
  freezeEntryContext: vi.fn(async () => ({ inserted: true })),
  isEntryContextEnabled: vi.fn(() => process.env.ENTRY_CONTEXT_FREEZE === '1'),
}))

import { getGmgnTokenSnapshotCached } from '@/utils/gmgn-snapshot-cache'
import { freezeEntryContext } from '@/strategies/token-entry-context'
import { captureTokenInfoDetectBatch } from '@/strategies/token-info-detect'

const MINT = 'So11111111111111111111111111111111111111112'
const item = {
  chain: 'sol',
  tokenAddress: MINT,
  detectingStrategy: 'mcap_enter_first_seen',
  source: 'mcap_first_seen' as const,
}

describe('captureTokenInfoDetectBatch -> entry context hook', () => {
  const prev = process.env.ENTRY_CONTEXT_FREEZE
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.ENTRY_CONTEXT_FREEZE
    else process.env.ENTRY_CONTEXT_FREEZE = prev
  })

  it('does not freeze while the flag is off', async () => {
    delete process.env.ENTRY_CONTEXT_FREEZE
    vi.mocked(getGmgnTokenSnapshotCached).mockResolvedValue(undefined as never)
    await captureTokenInfoDetectBatch([item])
    expect(freezeEntryContext).not.toHaveBeenCalled()
  })

  it('freezes once per Sol mint even when the GMGN panel capture finds nothing', async () => {
    process.env.ENTRY_CONTEXT_FREEZE = '1'
    vi.mocked(getGmgnTokenSnapshotCached).mockResolvedValue(undefined as never)
    const detectedAt = new Date('2026-10-04T03:00:00Z')
    await captureTokenInfoDetectBatch([
      { ...item, detectedAt },
      { ...item, detectingStrategy: 'second' },
      { ...item, chain: 'robinhood', tokenAddress: '0xabc' },
    ])
    expect(freezeEntryContext).toHaveBeenCalledTimes(1)
    expect(freezeEntryContext).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'sol', tokenAddress: MINT, detectingStrategy: 'mcap_enter_first_seen', detectedAt }),
    )
  })

  it('freezes even if the panel capture throws', async () => {
    process.env.ENTRY_CONTEXT_FREEZE = '1'
    vi.mocked(getGmgnTokenSnapshotCached).mockRejectedValue(new Error('gmgn 429'))
    await captureTokenInfoDetectBatch([item])
    expect(freezeEntryContext).toHaveBeenCalledTimes(1)
  })
})
