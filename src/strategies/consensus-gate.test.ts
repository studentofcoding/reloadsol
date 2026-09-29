import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONSENSUS_MIN_FAMILIES,
  consensusGateMode,
  decideConsensusGate,
  getConsensusMinFamilies,
} from './consensus-gate'

describe('consensusGateMode', () => {
  it('defaults to shadow — never enforces by accident', () => {
    expect(consensusGateMode({})).toBe('shadow')
    expect(consensusGateMode({ CONSENSUS_GATE_MODE: 'nonsense' })).toBe('shadow')
  })

  it('only enforces when asked', () => {
    expect(consensusGateMode({ CONSENSUS_GATE_MODE: 'enforce' })).toBe('enforce')
  })

  it('lets the kill switch force shadow over enforce', () => {
    expect(
      consensusGateMode({ CONSENSUS_GATE_MODE: 'enforce', CONSENSUS_GATE_KILL_SWITCH: '1' }),
    ).toBe('shadow')
  })

  it('supports off (no recording)', () => {
    expect(consensusGateMode({ CONSENSUS_GATE_MODE: 'off' })).toBe('off')
  })
})

describe('getConsensusMinFamilies', () => {
  it('defaults and validates', () => {
    expect(getConsensusMinFamilies({})).toBe(DEFAULT_CONSENSUS_MIN_FAMILIES)
    expect(getConsensusMinFamilies({ CONSENSUS_GATE_MIN_FAMILIES: '3' })).toBe(3)
    expect(getConsensusMinFamilies({ CONSENSUS_GATE_MIN_FAMILIES: '0' })).toBe(
      DEFAULT_CONSENSUS_MIN_FAMILIES,
    )
  })
})

describe('decideConsensusGate', () => {
  const significant = { significant: true, reason: 'CI excludes 0' }
  const notSignificant = { significant: false, reason: 'thin sample (2 tokens)' }

  it('never gates without evidence, in any mode', () => {
    for (const mode of ['shadow', 'enforce'] as const) {
      expect(
        decideConsensusGate({ familyCount: 0, minFamilies: 2, evidence: null, mode }).decision,
      ).toBe('no_evidence')
      expect(
        decideConsensusGate({
          familyCount: 0,
          minFamilies: 2,
          evidence: notSignificant,
          mode,
        }).decision,
      ).toBe('no_evidence')
    }
  })

  it('does not enforce an unproven signal', () => {
    const d = decideConsensusGate({
      familyCount: 0,
      minFamilies: 2,
      evidence: notSignificant,
      mode: 'enforce',
    })
    expect(d.enforced).toBe(false)
    expect(d.reason).toContain('not significant')
  })

  it('passes when enough families agree', () => {
    const d = decideConsensusGate({
      familyCount: 3,
      minFamilies: 2,
      evidence: significant,
      mode: 'enforce',
    })
    expect(d.decision).toBe('would_pass')
    expect(d.enforced).toBe(false)
  })

  it('would gate below the threshold once the lift is significant', () => {
    const d = decideConsensusGate({
      familyCount: 1,
      minFamilies: 2,
      evidence: significant,
      mode: 'enforce',
    })
    expect(d.decision).toBe('would_gate')
    expect(d.enforced).toBe(true)
  })

  it('records would_gate but does not enforce it in shadow mode', () => {
    const d = decideConsensusGate({
      familyCount: 1,
      minFamilies: 2,
      evidence: significant,
      mode: 'shadow',
    })
    expect(d.decision).toBe('would_gate')
    expect(d.enforced).toBe(false)
  })
})
