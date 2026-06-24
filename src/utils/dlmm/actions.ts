import type {
  DeployPositionInput,
  DlmmActionResult,
  EditPositionInput,
} from '@/types/dlmm';
import {
  appendLesson,
  getAgentConfig,
  getOpenSolAtRisk,
  getPositionById,
  insertPosition,
  updateAgentConfig,
  updatePosition,
} from '@/utils/dlmm/db';
import { createDlmmExecutor } from '@/utils/dlmm/executors';
import { fetchMeteoraPool, getFeeTvlRatio24h } from '@/utils/meteora';

async function enforceCapitalLimits(amountSol: number): Promise<string | null> {
  const config = await getAgentConfig();
  if (amountSol > config.max_sol_per_position) {
    return `Amount ${amountSol} SOL exceeds max per position (${config.max_sol_per_position})`;
  }
  const atRisk = await getOpenSolAtRisk();
  if (atRisk + amountSol > config.max_sol_at_risk) {
    return `Total at-risk ${atRisk + amountSol} SOL exceeds cap (${config.max_sol_at_risk})`;
  }
  return null;
}

export async function deployPosition(input: DeployPositionInput): Promise<DlmmActionResult> {
  const config = await getAgentConfig();
  const capError = await enforceCapitalLimits(input.amountSol);
  if (capError) {
    return { success: false, dryRun: config.dry_run, message: capError, error: capError };
  }

  let pool;
  try {
    pool = await fetchMeteoraPool(input.poolAddress);
  } catch (error) {
    return {
      success: false,
      dryRun: config.dry_run,
      message: 'Pool not found',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  const executor = await createDlmmExecutor();
  const binRange = input.binRangeInterval ?? config.bin_range_interval;
  const execResult = await executor.deploy({
    poolAddress: input.poolAddress,
    poolName: pool.name,
    amountSol: input.amountSol,
    binRangeInterval: binRange,
    strategyType: input.strategyType,
  });

  if (!execResult.success) return execResult;

  const entryUsd = input.amountSol * (pool.token_x.price ?? pool.current_price ?? 0);
  const position = await insertPosition({
    pool_address: input.poolAddress,
    pool_name: pool.name,
    position_pubkey: execResult.positionPubkey ?? null,
    min_bin_id: execResult.minBinId ?? null,
    max_bin_id: execResult.maxBinId ?? null,
    token_x_symbol: pool.token_x.symbol,
    token_y_symbol: pool.token_y.symbol,
    amount_sol: input.amountSol,
    entry_value_usd: entryUsd,
    current_value_usd: entryUsd,
    take_profit_pct: input.takeProfitPct ?? config.take_profit_pct,
    stop_loss_pct: input.stopLossPct ?? config.stop_loss_pct,
    oor_timeout_min: input.oorTimeoutMin ?? config.oor_timeout_min,
    status: 'open',
    tx_signature: execResult.signature ?? null,
    last_decision: 'DEPLOY',
    last_decision_reason: execResult.message,
    last_decision_at: new Date().toISOString(),
  });

  await appendLesson({
    position_id: position.id,
    pool_address: input.poolAddress,
    decision: 'DEPLOY',
    reason: execResult.message,
    pnl_pct: 0,
    fee_tvl_at_entry: getFeeTvlRatio24h(pool),
  });

  return {
    ...execResult,
    positionId: position.id,
    message: execResult.message,
  };
}

export async function editPosition(
  id: string,
  input: EditPositionInput,
): Promise<DlmmActionResult> {
  const config = await getAgentConfig();
  const position = await getPositionById(id);
  if (!position) {
    return { success: false, dryRun: config.dry_run, message: 'Position not found', error: 'NOT_FOUND' };
  }
  if (position.status === 'closed') {
    return { success: false, dryRun: config.dry_run, message: 'Position already closed', error: 'CLOSED' };
  }

  const patch: Record<string, unknown> = {};
  if (input.takeProfitPct != null) patch.take_profit_pct = input.takeProfitPct;
  if (input.stopLossPct != null) patch.stop_loss_pct = input.stopLossPct;
  if (input.oorTimeoutMin != null) patch.oor_timeout_min = input.oorTimeoutMin;
  if (input.muted != null) patch.is_muted = input.muted;

  if (input.binRangeInterval != null && position.position_pubkey && position.min_bin_id != null) {
    const executor = await createDlmmExecutor();
    await executor.remove({
      poolAddress: position.pool_address,
      positionPubkey: position.position_pubkey,
      minBinId: position.min_bin_id,
      maxBinId: position.max_bin_id ?? position.min_bin_id,
    });
    const redeploy = await executor.deploy({
      poolAddress: position.pool_address,
      poolName: position.pool_name,
      amountSol: position.amount_sol,
      binRangeInterval: input.binRangeInterval,
    });
    if (!redeploy.success) {
      return redeploy;
    }
    patch.last_decision = 'REDEPLOY';
    patch.last_decision_reason = redeploy.message;
    patch.last_decision_at = new Date().toISOString();
  }

  await updatePosition(id, patch as Parameters<typeof updatePosition>[1]);

  return {
    success: true,
    dryRun: config.dry_run,
    positionId: id,
    message: 'Position updated',
  };
}

export async function removePosition(id: string): Promise<DlmmActionResult> {
  const config = await getAgentConfig();
  const position = await getPositionById(id);
  if (!position) {
    return { success: false, dryRun: config.dry_run, message: 'Position not found', error: 'NOT_FOUND' };
  }
  if (position.status === 'closed') {
    return { success: true, dryRun: config.dry_run, positionId: id, message: 'Already closed' };
  }

  const executor = await createDlmmExecutor();
  let execResult: DlmmActionResult = {
    success: true,
    dryRun: config.dry_run,
    message: 'Closed (no on-chain pubkey)',
  };

  if (position.position_pubkey && position.min_bin_id != null && position.max_bin_id != null) {
    execResult = await executor.remove({
      poolAddress: position.pool_address,
      positionPubkey: position.position_pubkey,
      minBinId: position.min_bin_id,
      maxBinId: position.max_bin_id,
    });
    if (!execResult.success) return execResult;
  }

  await updatePosition(id, {
    status: 'closed',
    closed_at: new Date().toISOString(),
    last_decision: 'CLOSE',
    last_decision_reason: execResult.message,
    last_decision_at: new Date().toISOString(),
    tx_signature: execResult.signature ?? position.tx_signature,
  });

  await appendLesson({
    position_id: id,
    pool_address: position.pool_address,
    decision: 'CLOSE',
    reason: execResult.message,
    pnl_pct: position.pnl_pct,
    fee_tvl_at_entry: null,
  });

  const { recordDlmmOutcome } = await import('@/strategies/outcomes');
  await recordDlmmOutcome({
    strategyId: 'dlmm_default',
    poolAddress: position.pool_address,
    entryAt: position.created_at ?? null,
    exitAt: new Date().toISOString(),
    pnlPct: position.pnl_pct,
    status: (position.pnl_pct ?? 0) >= 0 ? 'won' : 'lost',
    isSimulated: config.dry_run,
    features: {
      pool_name: position.pool_name,
      position_id: id,
      amount_sol: position.amount_sol,
      close_reason: execResult.message,
      token_symbol: position.pool_name ?? position.token_x_symbol ?? position.token_y_symbol,
    },
  });

  return { ...execResult, positionId: id };
}

export async function setAgentEnabled(enabled: boolean): Promise<void> {
  await updateAgentConfig({ enabled } as Parameters<typeof updateAgentConfig>[0]);
}

export async function setDryRun(dryRun: boolean): Promise<void> {
  await updateAgentConfig({ dry_run: dryRun } as Parameters<typeof updateAgentConfig>[0]);
}

export async function updateThreshold(
  key: keyof Pick<
    import('@/types/dlmm').DlmmAgentConfig,
    'min_tvl' | 'min_fee_tvl' | 'min_organic_score' | 'min_holders' | 'take_profit_pct' | 'stop_loss_pct' | 'oor_timeout_min'
  >,
  value: number,
): Promise<void> {
  await updateAgentConfig({ [key]: value } as Parameters<typeof updateAgentConfig>[0]);
}
