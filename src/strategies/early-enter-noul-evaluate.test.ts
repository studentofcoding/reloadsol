import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateEarlyEnterNoulShadow } from './early-enter-noul-evaluate'
import * as shadowDb from './early-enter-noul-shadow-db'
import type { EarlyEnterNoulState } from './early-enter-noul-shadow'
import type { TypeSafeNoulCallResult } from './typesafe-noul'

vi.mock('./early-enter-noul-shadow-db', () => ({
  insertEarlyEnterNoulShadowRow: vi.fn(async () => undefined),
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe('evaluateEarlyEnterNoulShadow', () => {
  it('null cl_ml_score → skipped_null, no Noul call', async () => {
    const callNoul = vi.fn(async (): Promise<TypeSafeNoulCallResult> => ({
      ok: true,
      noul: 0.9,
      model: 'jev-test',
    }))
    const result = await evaluateEarlyEnterNoulShadow({
      tokenAddress: 'MintNull',
      symbol: 'NULL',
      chain: 'sol',
      strategyKey: 'mcap_enter_first_seen',
      clMlScore: null,
      clModelVersion: null,
      mlSoftGateEnabled: true,
      mlMin: 0.55,
      callNoul,
    })
    expect(result.band).toBe('skipped_null')
    expect(result.noulCalled).toBe(false)
    expect(result.specWouldPass).toBe(false)
    expect(result.decisionShadow).toBe('follow_spec')
    expect(callNoul).not.toHaveBeenCalled()
    expect(shadowDb.insertEarlyEnterNoulShadowRow).toHaveBeenCalledWith(
      expect.objectContaining({
        band: 'skipped_null',
        noulCalled: false,
        noul: null,
        specWouldPass: false,
      }),
    )
  })

  it('Noul 0.9 → keep; 0.1 → suppress; 0.5 → mid', async () => {
    for (const [noul, band] of [
      [0.9, 'keep'],
      [0.1, 'suppress'],
      [0.5, 'mid'],
    ] as const) {
      vi.clearAllMocks()
      const result = await evaluateEarlyEnterNoulShadow({
        tokenAddress: `Mint${band}`,
        chain: 'sol',
        strategyKey: 'mcap_enter_first_seen',
        clMlScore: 0.7,
        clModelVersion: 'cl-test',
        mlSoftGateEnabled: true,
        mlMin: 0.55,
        callNoul: async () => ({ ok: true, noul, model: 'jev-test' }),
      })
      expect(result.band).toBe(band)
      expect(result.noulCalled).toBe(true)
      expect(result.specWouldPass).toBe(true)
      if (band === 'mid') {
        expect(result.decisionShadow).toBe('follow_spec')
      } else {
        expect(result.decisionShadow).toBe(band)
      }
    }
  })

  it('Noul throw / miss → api_miss', async () => {
    const miss = await evaluateEarlyEnterNoulShadow({
      tokenAddress: 'MintMiss',
      chain: 'sol',
      strategyKey: 'mcap_enter_at_80',
      clMlScore: 0.7,
      mlSoftGateEnabled: true,
      mlMin: 0.55,
      callNoul: async () => ({ ok: false, reason: 'missing_creds' }),
    })
    expect(miss.band).toBe('api_miss')
    expect(miss.noulCalled).toBe(false)
    expect(miss.decisionShadow).toBe('follow_spec')

    const boom = await evaluateEarlyEnterNoulShadow({
      tokenAddress: 'MintBoom',
      chain: 'sol',
      strategyKey: 'mcap_enter_at_80',
      clMlScore: 0.7,
      mlSoftGateEnabled: true,
      mlMin: 0.55,
      callNoul: async () => {
        throw new Error('network')
      },
    })
    expect(boom.band).toBe('api_miss')
  })

  it('builds state with only locked Noul fields (no Z/pWinner)', async () => {
    let seen: EarlyEnterNoulState | null = null
    await evaluateEarlyEnterNoulShadow({
      tokenAddress: 'MintState',
      symbol: 'ST',
      chain: 'sol',
      strategyKey: 'mcap_enter_first_seen',
      clMlScore: 0.62,
      clModelVersion: 'cl-v1',
      mlSoftGateEnabled: true,
      mlMin: 0.55,
      callNoul: async (state) => {
        seen = state
        return { ok: true, noul: 0.85, model: 'jev-test' }
      },
    })
    expect(seen).toEqual({
      token_address: 'MintState',
      chain: 'sol',
      cl_ml_score: 0.62,
      cl_model_version: 'cl-v1',
      EARLY_ENTER_ML_MIN: 0.55,
      EARLY_ENTER_ML_SOFT_GATE: true,
      spec_would_pass: true,
      symbol: 'ST',
    })
    expect(seen).not.toHaveProperty('pWinner')
    expect(seen).not.toHaveProperty('z_score')
  })
})
