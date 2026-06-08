import type { DlmmDecision } from '@/types/dlmm';
import { getAgentConfig } from '@/utils/dlmm/db';

export interface ReasonerInput {
  poolName: string;
  pnlPct: number;
  inRange: boolean;
  oorMinutes: number;
  oorTimeoutMin: number;
  takeProfitPct: number;
  stopLossPct: number;
  feeTvl24h: number;
}

export interface ReasonerOutput {
  decision: DlmmDecision;
  reason: string;
  usedLlm: boolean;
}

/**
 * Deterministic rule engine (default). Optional LLM hook behind use_llm_reasoner flag.
 */
export async function decidePositionAction(input: ReasonerInput): Promise<ReasonerOutput> {
  const config = await getAgentConfig();

  if (config.use_llm_reasoner && process.env.DLMM_LLM_API_URL) {
    try {
      const llmResult = await callLlmReasoner(input);
      if (llmResult) return { ...llmResult, usedLlm: true };
    } catch (error) {
      console.warn('[DLMM Reasoner] LLM failed, using rules:', error);
    }
  }

  if (input.pnlPct >= input.takeProfitPct) {
    return {
      decision: 'CLOSE',
      reason: `Trailing TP: PnL ${input.pnlPct.toFixed(2)}% >= ${input.takeProfitPct}%`,
      usedLlm: false,
    };
  }

  if (input.pnlPct <= input.stopLossPct) {
    return {
      decision: 'CLOSE',
      reason: `Stop loss: PnL ${input.pnlPct.toFixed(2)}% <= ${input.stopLossPct}%`,
      usedLlm: false,
    };
  }

  if (!input.inRange && input.oorMinutes >= input.oorTimeoutMin) {
    return {
      decision: 'CLOSE',
      reason: `Out of range ${input.oorMinutes}m (limit ${input.oorTimeoutMin}m)`,
      usedLlm: false,
    };
  }

  if (!input.inRange && input.oorMinutes >= Math.floor(input.oorTimeoutMin / 2)) {
    return {
      decision: 'REDEPLOY',
      reason: `OOR ${input.oorMinutes}m — prepare redeploy around active bin`,
      usedLlm: false,
    };
  }

  if (input.feeTvl24h < 0.05 && input.pnlPct < 1) {
    return {
      decision: 'CLOSE',
      reason: `Low yield: fee/TVL ${(input.feeTvl24h * 100).toFixed(2)}% with weak PnL`,
      usedLlm: false,
    };
  }

  return {
    decision: 'STAY',
    reason: input.inRange ? 'In range, metrics healthy' : `OOR ${input.oorMinutes}m (under limit)`,
    usedLlm: false,
  };
}

async function callLlmReasoner(input: ReasonerInput): Promise<ReasonerOutput | null> {
  const url = process.env.DLMM_LLM_API_URL;
  if (!url) return null;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: `DLMM position ${input.poolName}: pnl=${input.pnlPct}%, inRange=${input.inRange}, oorMin=${input.oorMinutes}. Reply JSON: {decision: STAY|CLOSE|REDEPLOY, reason: string}`,
      input,
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  if (!data?.decision || !data?.reason) return null;
  return {
    decision: data.decision as DlmmDecision,
    reason: String(data.reason),
    usedLlm: true,
  };
}
