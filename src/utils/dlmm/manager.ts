import type { DlmmManageCycleResult } from '@/types/dlmm';
import { formatDbError } from '@/utils/db-health';
import { removePosition } from '@/utils/dlmm/actions';
import { getAgentConfig, getPositions, updatePosition } from '@/utils/dlmm/db';
import { getDlmmDbStatus } from '@/utils/dlmm/db-status';
import { createDlmmExecutor } from '@/utils/dlmm/executors';
import { decidePositionAction } from '@/utils/dlmm/reasoner';
import { fetchMeteoraPool, getFeeTvlRatio24h } from '@/utils/meteora';
import { sendDlmmDecisionAlert } from '@/utils/telegram';

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

    for (const position of openPositions) {
      try {
        await processPosition(position, config, executor, decisions);
      } catch (error) {
        console.warn(
          `[dlmm/manage] position ${position.id} skipped:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    const all = await getPositions();
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

    let feeTvl24h = 0;
    try {
      const pool = await fetchMeteoraPool(position.pool_address);
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
    } catch {
      // keep last known values
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
      await updatePosition(position.id, {
        last_decision: 'REDEPLOY',
        last_decision_reason: `${reasoned.reason} (active bin ${activeBinId})`,
        last_decision_at: new Date().toISOString(),
      });
      executed = true;
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
