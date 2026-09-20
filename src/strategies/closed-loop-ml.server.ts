/**
 * Train + persist the phase-4 closed-loop model from labeled principal outcomes.
 */
import {
  CLOSED_LOOP_PRINCIPAL_IDS,
  collectClosedLoopTrainRows,
  trainClosedLoopModel,
  type ClosedLoopModelArtifact,
  type ClosedLoopTrainResult,
} from './closed-loop-ml'
import { saveClosedLoopModel } from './closed-loop-ml-cache'
import type { StrategyOutcomeRow } from './types'

export async function trainClosedLoopFromOutcomes(
  rows: StrategyOutcomeRow[],
  opts?: { now?: Date; version?: string },
): Promise<ClosedLoopTrainResult> {
  const collected = collectClosedLoopTrainRows(rows)
  const model = trainClosedLoopModel(collected.rows, opts)
  return {
    model,
    used: collected.rows.length,
    skipped_unlabeled: collected.skipped_unlabeled,
    skipped_not_principal: collected.skipped_not_principal,
  }
}

export async function trainAndPersistClosedLoopModel(opts?: {
  now?: Date
  version?: string
  dryRun?: boolean
}): Promise<ClosedLoopTrainResult & { path: string | null }> {
  const { loadOutcomesForMlDataset } = await import('./db')
  const rows: StrategyOutcomeRow[] = []
  for (const strategyId of CLOSED_LOOP_PRINCIPAL_IDS) {
    const batch = await loadOutcomesForMlDataset({ strategyId })
    rows.push(...batch)
  }
  const result = await trainClosedLoopFromOutcomes(rows, opts)
  if (opts?.dryRun) {
    return { ...result, path: null }
  }
  const path = saveClosedLoopModel(result.model)
  return { ...result, path }
}

export function persistClosedLoopModel(model: ClosedLoopModelArtifact): string {
  return saveClosedLoopModel(model)
}
