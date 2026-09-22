/**
 * Evaluate Noul shadow for one Stage-1 Early Enter candidate.
 * Always inserts a shadow row when arm-scoped; never throws to caller.
 * Paper / sim-open must never import or call this.
 */

import type { AppNetwork } from '@/utils/app-network'
import {
  buildEarlyEnterNoulState,
  classifyNoulBand,
  computeSpecWouldPass,
  decisionShadowFromBand,
  decisionSpecFromPass,
  getEarlyEnterNoulNo,
  getEarlyEnterNoulYes,
  type EarlyEnterNoulStrategyKey,
  type NoulShadowBand,
  type NoulShadowDecision,
  type NoulSpecDecision,
} from './early-enter-noul-shadow'
import { insertEarlyEnterNoulShadowRow } from './early-enter-noul-shadow-db'
import { callTypeSafeNoul, type TypeSafeNoulCallResult } from './typesafe-noul'

export type EarlyEnterNoulEvaluateInput = {
  tokenAddress: string
  symbol?: string | null
  chain: AppNetwork
  strategyKey: EarlyEnterNoulStrategyKey
  clMlScore: number | null | undefined
  clModelVersion?: string | null
  mlSoftGateEnabled: boolean
  mlMin: number
  /** Injectable for tests — when omitted, uses TypeSafe HTTP client. */
  callNoul?: (state: ReturnType<typeof buildEarlyEnterNoulState>) => Promise<TypeSafeNoulCallResult>
}

export type EarlyEnterNoulEvaluateResult = {
  strategyKey: EarlyEnterNoulStrategyKey
  specWouldPass: boolean
  band: NoulShadowBand
  noul: number | null
  noulCalled: boolean
  decisionShadow: NoulShadowDecision
  decisionSpec: NoulSpecDecision
}

export async function evaluateEarlyEnterNoulShadow(
  input: EarlyEnterNoulEvaluateInput,
): Promise<EarlyEnterNoulEvaluateResult> {
  const cl =
    input.clMlScore != null && Number.isFinite(input.clMlScore)
      ? input.clMlScore
      : null
  const specWouldPass = computeSpecWouldPass(cl, {
    enabled: input.mlSoftGateEnabled,
    min: input.mlMin,
  })
  const decisionSpec = decisionSpecFromPass(specWouldPass)

  // Null / non-finite cl → skip Noul (SPEC already suppresses when gate on).
  if (cl == null) {
    const band: NoulShadowBand = 'skipped_null'
    const decisionShadow = decisionShadowFromBand(band)
    await insertEarlyEnterNoulShadowRow({
      tokenAddress: input.tokenAddress,
      symbol: input.symbol,
      chain: input.chain,
      strategyKey: input.strategyKey,
      clMlScore: null,
      clModelVersion: input.clModelVersion ?? null,
      specWouldPass,
      noulCalled: false,
      noul: null,
      band,
      decisionShadow,
      decisionSpec,
    })
    return {
      strategyKey: input.strategyKey,
      specWouldPass,
      band,
      noul: null,
      noulCalled: false,
      decisionShadow,
      decisionSpec,
    }
  }

  const state = buildEarlyEnterNoulState({
    tokenAddress: input.tokenAddress,
    chain: input.chain,
    clMlScore: cl,
    clModelVersion: input.clModelVersion,
    specWouldPass,
    symbol: input.symbol,
    mlMin: input.mlMin,
    mlSoftGateEnabled: input.mlSoftGateEnabled,
  })

  const call = input.callNoul ?? ((s) => callTypeSafeNoul(s))
  let noul: number | null = null
  let noulCalled = false
  let apiMiss = false

  try {
    const result = await call(state)
    if (result.ok) {
      noul = result.noul
      noulCalled = true
    } else {
      apiMiss = true
    }
  } catch {
    apiMiss = true
  }

  const band = classifyNoulBand(noul, {
    no: getEarlyEnterNoulNo(),
    yes: getEarlyEnterNoulYes(),
    apiMiss,
  })
  const decisionShadow = decisionShadowFromBand(band)

  await insertEarlyEnterNoulShadowRow({
    tokenAddress: input.tokenAddress,
    symbol: input.symbol,
    chain: input.chain,
    strategyKey: input.strategyKey,
    clMlScore: cl,
    clModelVersion: input.clModelVersion ?? null,
    specWouldPass,
    noulCalled,
    noul: noulCalled ? noul : null,
    band,
    decisionShadow,
    decisionSpec,
  })

  return {
    strategyKey: input.strategyKey,
    specWouldPass,
    band,
    noul: noulCalled ? noul : null,
    noulCalled,
    decisionShadow,
    decisionSpec,
  }
}
