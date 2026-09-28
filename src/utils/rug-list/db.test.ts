import { describe, expect, it } from 'vitest'
import { sanitizeTokenSymbol } from './db'

describe('sanitizeTokenSymbol', () => {
  it('keeps a normal ticker', () => {
    expect(sanitizeTokenSymbol('POTATCHI')).toBe('POTATCHI')
    expect(sanitizeTokenSymbol('  r/acc  ')).toBe('r/acc')
  })

  it('drops the comma-joined market list seen in prod (28k chars)', () => {
    const dump = Array.from({ length: 5000 }, (_, i) => `TIC${i}`).join(',')
    expect(dump.length).toBeGreaterThan(20000)
    expect(sanitizeTokenSymbol(dump)).toBeNull()
  })

  it('drops an over-long concatenated pair list', () => {
    expect(sanitizeTokenSymbol('BTCETHUSDTBNBUSDCXRPSOLTRXHYPEDOGERAINZEC')).toBeNull()
  })

  it('drops a long prose name', () => {
    expect(
      sanitizeTokenSymbol('This Coin Is Going To Completely Fuck Up Your Shit Dawg Lmfao'),
    ).toBeNull()
  })

  it('drops empty and non-string input', () => {
    expect(sanitizeTokenSymbol('')).toBeNull()
    expect(sanitizeTokenSymbol('   ')).toBeNull()
    expect(sanitizeTokenSymbol(null)).toBeNull()
    expect(sanitizeTokenSymbol(undefined)).toBeNull()
    expect(sanitizeTokenSymbol(42)).toBeNull()
  })

  it('drops embedded newlines', () => {
    expect(sanitizeTokenSymbol('TILE\nEXTRA')).toBeNull()
  })
})
