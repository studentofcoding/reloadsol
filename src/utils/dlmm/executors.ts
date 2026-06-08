import { Keypair } from '@solana/web3.js';
import { loadTradingKeypair } from '@/utils/trade-executors';
import {
  buildAddLiquidityTx,
  buildRemoveLiquidityTx,
  estimatePositionInRange,
  getActiveBinInfo,
} from '@/utils/dlmm-sdk';
import type { DlmmActionResult, DlmmStrategyType } from '@/types/dlmm';
import { getAgentConfig } from '@/utils/dlmm/db';

export interface DeployExecutorParams {
  poolAddress: string;
  poolName: string;
  amountSol: number;
  binRangeInterval: number;
  strategyType?: DlmmStrategyType;
}

export interface RemoveExecutorParams {
  poolAddress: string;
  positionPubkey: string;
  minBinId: number;
  maxBinId: number;
}

export interface DlmmExecutor {
  deploy(params: DeployExecutorParams): Promise<DlmmActionResult>;
  remove(params: RemoveExecutorParams): Promise<DlmmActionResult>;
  checkRange(poolAddress: string, minBinId: number, maxBinId: number): Promise<{ inRange: boolean; activeBinId: number }>;
}

class SimulationDlmmExecutor implements DlmmExecutor {
  async deploy(params: DeployExecutorParams): Promise<DlmmActionResult> {
    const active = await getActiveBinInfo(params.poolAddress).catch(() => ({
      binId: 0,
      price: 0,
      pricePerToken: 0,
      xAmount: '0',
      yAmount: '0',
    }));

    return {
      success: true,
      dryRun: true,
      positionPubkey: `dryrun-${Date.now()}`,
      minBinId: active.binId - params.binRangeInterval,
      maxBinId: active.binId + params.binRangeInterval,
      message: `[DRY RUN] Would deploy ${params.amountSol} SOL into ${params.poolName} (bins ±${params.binRangeInterval}, active bin ${active.binId})`,
    };
  }

  async remove(params: RemoveExecutorParams): Promise<DlmmActionResult> {
    return {
      success: true,
      dryRun: true,
      message: `[DRY RUN] Would remove liquidity from position ${params.positionPubkey.slice(0, 8)}...`,
    };
  }

  async checkRange(poolAddress: string, minBinId: number, maxBinId: number) {
    try {
      return await estimatePositionInRange(poolAddress, minBinId, maxBinId);
    } catch {
      return { inRange: true, activeBinId: 0 };
    }
  }
}

class RealDlmmExecutor implements DlmmExecutor {
  private keypair: Keypair;

  constructor(keypair: Keypair) {
    this.keypair = keypair;
  }

  async deploy(params: DeployExecutorParams): Promise<DlmmActionResult> {
    const result = await buildAddLiquidityTx({
      poolAddress: params.poolAddress,
      user: this.keypair,
      amountSol: params.amountSol,
      binRangeInterval: params.binRangeInterval,
      strategyType: params.strategyType,
    });

    if (!result.success) {
      return {
        success: false,
        dryRun: false,
        message: 'Deploy failed',
        error: result.error,
      };
    }

    return {
      success: true,
      dryRun: false,
      signature: result.signature,
      positionPubkey: result.positionPubkey,
      minBinId: result.minBinId,
      maxBinId: result.maxBinId,
      message: `Deployed ${params.amountSol} SOL into ${params.poolName}`,
    };
  }

  async remove(params: RemoveExecutorParams): Promise<DlmmActionResult> {
    const result = await buildRemoveLiquidityTx({
      poolAddress: params.poolAddress,
      user: this.keypair,
      positionPubkey: params.positionPubkey,
      minBinId: params.minBinId,
      maxBinId: params.maxBinId,
    });

    if (!result.success) {
      return {
        success: false,
        dryRun: false,
        message: 'Remove failed',
        error: result.error,
      };
    }

    return {
      success: true,
      dryRun: false,
      signature: result.signature,
      message: `Removed liquidity from ${params.positionPubkey.slice(0, 8)}...`,
    };
  }

  async checkRange(poolAddress: string, minBinId: number, maxBinId: number) {
    return estimatePositionInRange(poolAddress, minBinId, maxBinId);
  }
}

export async function createDlmmExecutor(): Promise<DlmmExecutor> {
  const config = await getAgentConfig();
  if (config.dry_run) {
    return new SimulationDlmmExecutor();
  }
  try {
    const keypair = loadTradingKeypair();
    return new RealDlmmExecutor(keypair);
  } catch (error) {
    console.warn('[DLMM] No trading keypair, falling back to simulation:', error);
    return new SimulationDlmmExecutor();
  }
}
