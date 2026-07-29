import { Keypair, sendAndConfirmTransaction } from '@solana/web3.js';
import { loadTradingKeypair } from '@/utils/trade-executors';
import {
  buildAddLiquidityTx,
  buildRemoveLiquidityTx,
  createDlmmPool,
  estimatePositionInRange,
  getActiveBinInfo,
  getDlmmConnection,
} from '@/utils/dlmm-sdk';
import type { DlmmActionResult, DlmmStrategyType } from '@/types/dlmm';
import { getAgentConfig } from '@/utils/dlmm/db';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

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

export interface ClaimFeesExecutorParams {
  poolAddress: string;
  positionPubkey: string;
  /** Claim only when the SOL-leg claimable fee reaches this many SOL. */
  thresholdSol: number;
}

export interface DlmmExecutor {
  deploy(params: DeployExecutorParams): Promise<DlmmActionResult>;
  remove(params: RemoveExecutorParams): Promise<DlmmActionResult>;
  checkRange(poolAddress: string, minBinId: number, maxBinId: number): Promise<{ inRange: boolean; activeBinId: number }>;
  claimFeesIfAbove(params: ClaimFeesExecutorParams): Promise<DlmmActionResult & { claimed?: boolean }>;
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

  async claimFeesIfAbove(_params: ClaimFeesExecutorParams) {
    return {
      success: true,
      dryRun: true,
      claimed: false,
      message: '[DRY RUN] fee claim skipped (simulation)',
    };
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

  async claimFeesIfAbove(params: ClaimFeesExecutorParams) {
    try {
      const pool = await createDlmmPool(params.poolAddress);
      const { userPositions } = await pool.getPositionsByUserAndLbPair(
        this.keypair.publicKey,
      );
      const lbPosition = userPositions.find(
        (p) => p.publicKey.toBase58() === params.positionPubkey,
      );
      if (!lbPosition) {
        return {
          success: true,
          dryRun: false,
          claimed: false,
          message: 'Position not found on-chain — fee claim skipped',
        };
      }

      // Threshold applies to the SOL leg of claimable fees.
      const xIsSol = pool.tokenX.publicKey.toBase58() === SOL_MINT;
      const yIsSol = pool.tokenY.publicKey.toBase58() === SOL_MINT;
      const solFeeLamports = xIsSol
        ? BigInt(lbPosition.positionData.feeX.toString())
        : yIsSol
          ? BigInt(lbPosition.positionData.feeY.toString())
          : BigInt(0);
      const thresholdLamports = BigInt(
        Math.max(0, Math.floor(params.thresholdSol * 1e9)),
      );
      if (solFeeLamports < thresholdLamports) {
        return {
          success: true,
          dryRun: false,
          claimed: false,
          message: 'Claimable fees below auto-claim threshold',
        };
      }

      const txs = await pool.claimSwapFee({
        owner: this.keypair.publicKey,
        position: lbPosition,
      });
      let lastSig: string | undefined;
      for (const tx of txs) {
        lastSig = await sendAndConfirmTransaction(
          getDlmmConnection(),
          tx,
          [this.keypair],
          { skipPreflight: false, maxRetries: 2 },
        );
      }
      return {
        success: true,
        dryRun: false,
        claimed: true,
        signature: lastSig,
        message: `Auto-claimed ~${(Number(solFeeLamports) / 1e9).toFixed(4)} SOL in swap fees`,
      };
    } catch (error) {
      return {
        success: false,
        dryRun: false,
        claimed: false,
        message: 'Fee claim failed',
        error: error instanceof Error ? error.message : 'Fee claim failed',
      };
    }
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
