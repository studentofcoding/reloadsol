import type { DlmmManageCycleResult } from '@/types/dlmm';
import { formatDbError } from '@/utils/db-health';
import { removePosition } from '@/utils/dlmm/actions';
import { getAgentConfig, getPositions, updatePosition } from '@/utils/dlmm/db';
import { getDlmmDbStatus } from '@/utils/dlmm/db-status';
import { DLMM_CONFIG } from '@/utils/dlmm/config';
import { createDlmmExecutor } from '@/utils/dlmm/executors';
import { decidePositionAction } from '@/utils/dlmm/reasoner';
import { fetchMeteoraPool, getFeeTvlRatio24h } from '@/utils/meteora';
import { sendDlmmDecisionAlert } from '@/utils/telegram';

type MeteoraPool = Awaited<ReturnType<typeof fetchMeteoraPool>>;

export async function runDlmmManageCycle(): Promise<DlmmManageCycleResult> {
  const empty: DlmmManageCycleResult = {
    success: true,
    decisions: [],
    activeCount: 0,
    closedCount: 0,
  };

  try {
    const dbStatus = await getDlmmDbStatus();
    if (!dbStatus.reachable || !dbStatus.schemaReady) {
      return {
        ...empty,
        skipped: true,
        reason: dbStatus.error ?? 'Supabase unavailable',
      };
    }

    const config = await getAgentConfig();
    const decisions: DlmmManageCycleResult['decisions'] = [];

    if (config.id === 'env-fallback') {
      return {
        ...empty,
        skipped: true,
        reason: 'Supabase unavailable — manage cycle skipped',
      };
    }

    if (!config.enabled) {
      return {
        ...empty,
        skipped: true,
        reason: 'DLMM agent paused (DLMM_AGENT_ENABLED=false)',
      };
    }

    const positions = await getPositions();
    const openPositions = positions.filter((p) =>
      ['open', 'out_of_range', 'pending'].includes(p.status),
    );
    const executor = await createDlmmExecutor();

    // Fetch each unique pool once per cycle and share across positions (rec 3.6).
    const poolByAddress = new Map<string, MeteoraPool | null>();
    const uniquePools = [...new Set(openPositions.map((p) => p.pool_address))];
    await Promise.all(
      uniquePools.map(async (addr) => {
        try {
          poolByAddress.set(addr, await fetchMeteoraPool(addr));
        } catch {
          poolByAddress.set(addr, null);
        }
      }),
    );

    for (const position of openPositions) {
      try {
        await processPosition(position, config, executor, decisions, poolByAddress);
      } catch (error) {
        console.warn(
          `[dlmm/manage] position ${position.id} skipped:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    const all = await getPositions();
    try {
      const { syncMissingDlmmOutcomesFromPositions } = await import(
        '@/strategies/outcomes'
      );
      await syncMissingDlmmOutcomesFromPositions();
    } catch (error) {
      console.warn(
        '[dlmm/manage] dlmm outcome backfill skipped:',
        error instanceof Error ? error.message : error,
      );
    }
    return {
      success: true,
      decisions,
      activeCount: all.filter((p) =>
        ['open', 'out_of_range', 'pending'].includes(p.status),
      ).length,
      closedCount: all.filter((p) => p.status === 'closed').length,
    };
  } catch (error) {
    console.error('[dlmm/manage] cycle error:', formatDbError(error));
    return {
      ...empty,
      success: false,
      skipped: true,
      reason: formatDbError(error),
    };
  }
}

async function processPosition(
  position: Awaited<ReturnType<typeof getPositions>>[number],
  config: Awaited<ReturnType<typeof getAgentConfig>>,
  executor: Awaited<ReturnType<typeof createDlmmExecutor>>,
  decisions: DlmmManageCycleResult['decisions'],
  poolByAddress: Map<string, MeteoraPool | null>,
) {
  if (position.is_muted || config.muted_positions.includes(position.id)) {
    return;
  }

    let inRange = true;
    let activeBinId = 0;
    if (position.min_bin_id != null && position.max_bin_id != null) {
      const range = await executor.checkRange(
        position.pool_address,
        position.min_bin_id,
        position.max_bin_id,
      );
      inRange = range.inRange;
      activeBinId = range.activeBinId;
    }

    const now = Date.now();
    let oorSince = position.oor_since ? new Date(position.oor_since).getTime() : null;
    if (!inRange) {
      if (!oorSince) {
        oorSince = now;
        await updatePosition(position.id, {
          status: 'out_of_range',
          oor_since: new Date(now).toISOString(),
        });
      }
    } else if (position.status === 'out_of_range') {
      await updatePosition(position.id, { status: 'open', oor_since: null });
      oorSince = null;
    }

    const oorMinutes = oorSince ? Math.floor((now - oorSince) / 60000) : 0;

    // Auto-claim swap fees when the SOL leg exceeds a small threshold (rec 3.5).
    if (position.position_pubkey) {
      try {
        const claim = await executor.claimFeesIfAbove({
          poolAddress: position.pool_address,
          positionPubkey: position.position_pubkey,
          thresholdSol: DLMM_CONFIG.autoClaimFeeSol,
        });
        if (claim.claimed) {
          await sendDlmmDecisionAlert({
            poolName: position.pool_name,
            decision: 'CLAIM_FEES',
            reason: claim.message,
            pnlPct: position.pnl_pct,
            positionId: position.id,
          });
        }
      } catch (error) {
        console.warn(
          `[dlmm/manage] fee claim skipped for ${position.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    let feeTvl24h = 0;
    const pool = poolByAddress.get(position.pool_address) ?? null;
    if (pool) {
      feeTvl24h = getFeeTvlRatio24h(pool);
      const solPrice = pool.token_x.price ?? pool.current_price ?? 0;
      const currentValue = position.amount_sol * solPrice;
      const pnlPct =
        position.entry_value_usd > 0
          ? ((currentValue - position.entry_value_usd) / position.entry_value_usd) * 100
          : 0;

      await updatePosition(position.id, {
        current_value_usd: currentValue,
        pnl_pct: pnlPct,
      });
      position.pnl_pct = pnlPct;
      position.current_value_usd = currentValue;
    }

    const reasoned = await decidePositionAction({
      poolName: position.pool_name,
      pnlPct: position.pnl_pct,
      inRange,
      oorMinutes,
      oorTimeoutMin: position.oor_timeout_min,
      takeProfitPct: position.take_profit_pct,
      stopLossPct: position.stop_loss_pct,
      feeTvl24h,
    });

    let executed = false;

    if (reasoned.decision === 'CLOSE') {
      const result = await removePosition(position.id);
      executed = result.success;
    } else if (reasoned.decision === 'REDEPLOY') {
      executed = await redeployPosition(position, config, executor, reasoned.reason, activeBinId);
    } else {
      await updatePosition(position.id, {
        last_decision: reasoned.decision,
        last_decision_reason: reasoned.reason,
        last_decision_at: new Date().toISOString(),
      });
    }

    if (reasoned.decision !== 'STAY') {
      await sendDlmmDecisionAlert({
        poolName: position.pool_name,
        decision: reasoned.decision,
        reason: reasoned.reason,
        pnlPct: position.pnl_pct,
        positionId: position.id,
      });
    }

  decisions.push({
    positionId: position.id,
    poolName: position.pool_name,
    decision: reasoned.decision,
    reason: reasoned.reason,
    pnlPct: position.pnl_pct,
    executed,
  });
}

/**
 * Real REDEPLOY (rec 3.5): remove liquidity, then re-deploy around the active
 * bin with the configured bin range. Mirrors the manual editPosition flow in
 * actions.ts. Dry-run/sim executors make this a safe logged no-op on-chain.
 */
async function redeployPosition(
  position: Awaited<ReturnType<typeof getPositions>>[number],
  config: Awaited<ReturnType<typeof getAgentConfig>>,
  executor: Awaited<ReturnType<typeof createDlmmExecutor>>,
  reason: string,
  activeBinId: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  const fail = async (message: string) => {
    await updatePosition(position.id, {
      last_decision: 'REDEPLOY',
      last_decision_reason: `${reason} — redeploy failed: ${message}`,
      last_decision_at: now,
    });
    return false;
  };

  if (!position.position_pubkey || position.min_bin_id == null) {
    await updatePosition(position.id, {
      last_decision: 'REDEPLOY',
      last_decision_reason: `${reason} (active bin ${activeBinId}) — skipped: no on-chain pubkey`,
      last_decision_at: now,
    });
    return false;
  }

  const removed = await executor.remove({
    poolAddress: position.pool_address,
    positionPubkey: position.position_pubkey,
    minBinId: position.min_bin_id,
    maxBinId: position.max_bin_id ?? position.min_bin_id,
  });
  if (!removed.success) {
    return fail(removed.error ?? removed.message);
  }

  const redeployed = await executor.deploy({
    poolAddress: position.pool_address,
    poolName: position.pool_name,
    amountSol: position.amount_sol,
    binRangeInterval: config.bin_range_interval,
  });
  if (!redeployed.success) {
    return fail(redeployed.error ?? redeployed.message);
  }

  await updatePosition(position.id, {
    position_pubkey: redeployed.positionPubkey ?? position.position_pubkey,
    min_bin_id: redeployed.minBinId ?? position.min_bin_id,
    max_bin_id: redeployed.maxBinId ?? position.max_bin_id,
    status: 'open',
    oor_since: null,
    tx_signature: redeployed.signature ?? position.tx_signature,
    last_decision: 'REDEPLOY',
    last_decision_reason:
      `${reason} — redeployed ±${config.bin_range_interval} bins around active bin ${activeBinId}` +
      (redeployed.signature ? ` (tx ${redeployed.signature.slice(0, 12)}…)` : ''),
    last_decision_at: now,
  });
  return true;
}
