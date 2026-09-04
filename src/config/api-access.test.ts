import { describe, expect, it } from 'vitest'
import { getApiAccessTier } from './api-access'

describe('getApiAccessTier', () => {
  it('keeps /api/trade/test behind a dev session', () => {
    expect(getApiAccessTier('/api/trade/test', 'GET')).toBe('dev')
    expect(getApiAccessTier('/api/trade/test', 'POST')).toBe('dev')
  })

  it('keeps sol-arb live execute behind a dev session', () => {
    expect(getApiAccessTier('/api/sol-arb/execute', 'POST')).toBe('dev')
    expect(getApiAccessTier('/api/sol-arb/execute-atomic', 'POST')).toBe('dev')
  })

  it('keeps /api/fomo ingest health behind a dev session', () => {
    expect(getApiAccessTier('/api/fomo/ingest', 'GET')).toBe('dev')
  })
})
