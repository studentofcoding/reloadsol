import DLMM, { StrategyType } from '@meteora-ag/dlmm';
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { connection } from '@/utils/connection';
import type { DlmmStrategyType } from '@/types/dlmm';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export function getDlmmConnection(): Connection {
  return connection;
}

export async function createDlmmPool(poolAddress: string) {
  const pubkey = new PublicKey(poolAddress);
  return DLMM.create(getDlmmConnection(), pubkey);
}

export async function getActiveBinInfo(poolAddress: string) {
  const pool = await createDlmmPool(poolAddress);
  const activeBin = await pool.getActiveBin();
  const pricePerToken = pool.fromPricePerLamport(Number(activeBin.price));
  return {
    binId: activeBin.binId,
    price: Number(activeBin.price),
    pricePerToken: Number(pricePerToken),
    xAmount: activeBin.xAmount?.toString?.() ?? '0',
    yAmount: activeBin.yAmount?.toString?.() ?? '0',
  };
}

export function mapStrategyType(strategy: DlmmStrategyType): StrategyType {
  switch (strategy) {
    case 'bid_ask':
      return StrategyType.BidAsk;
    case 'curve':
      return StrategyType.Curve;
    default:
      return StrategyType.Spot;
  }
}

export async function getUserDlmmPositions(wallet: PublicKey) {
  const pool = await DLMM.create(getDlmmConnection(), new PublicKey(SOL_MINT));
  // Fallback: scan via getAllLbPairPositionsByUser if available on default export
  if (typeof (DLMM as unknown as { getAllLbPairPositionsByUser?: Function }).getAllLbPairPositionsByUser === 'function') {
    return (DLMM as unknown as { getAllLbPairPositionsByUser: (c: Connection, u: PublicKey) => Promise<unknown> })
      .getAllLbPairPositionsByUser(getDlmmConnection(), wallet);
  }
  return pool.getPositionsByUserAndLbPair?.(wallet) ?? [];
}

export interface AddLiquidityParams {
  poolAddress: string;
  user: Keypair;
  amountSol: number;
  binRangeInterval: number;
  strategyType?: DlmmStrategyType;
}

export interface LiquidityTxResult {
  success: boolean;
  signature?: string;
  positionPubkey?: string;
  minBinId?: number;
  maxBinId?: number;
  error?: string;
}

export async function buildAddLiquidityTx(params: AddLiquidityParams): Promise<LiquidityTxResult> {
  try {
    const pool = await createDlmmPool(params.poolAddress);
    const activeBin = await pool.getActiveBin();
    const minBinId = activeBin.binId - params.binRangeInterval;
    const maxBinId = activeBin.binId + params.binRangeInterval;
    const positionKeypair = Keypair.generate();

    const lamports = Math.floor(params.amountSol * 1e9);
    const totalXAmount = new BN(lamports);
    const totalYAmount = new BN(0);

    const tx = await pool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: params.user.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: {
        minBinId,
        maxBinId,
        strategyType: mapStrategyType(params.strategyType ?? 'spot'),
      },
    });

    const signature = await sendAndConfirmTransaction(
      getDlmmConnection(),
      tx,
      [params.user, positionKeypair],
      { skipPreflight: false, maxRetries: 2 },
    );

    return {
      success: true,
      signature,
      positionPubkey: positionKeypair.publicKey.toBase58(),
      minBinId,
      maxBinId,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Add liquidity failed',
    };
  }
}

export async function buildRemoveLiquidityTx(params: {
  poolAddress: string;
  user: Keypair;
  positionPubkey: string;
  minBinId: number;
  maxBinId: number;
}): Promise<LiquidityTxResult> {
  try {
    const pool = await createDlmmPool(params.poolAddress);
    const position = new PublicKey(params.positionPubkey);

    const txs = await pool.removeLiquidity({
      user: params.user.publicKey,
      position,
      fromBinId: params.minBinId,
      toBinId: params.maxBinId,
      bps: new BN(10000),
      shouldClaimAndClose: true,
    });

    const txList = Array.isArray(txs) ? txs : [txs];
    let lastSig: string | undefined;

    for (const tx of txList) {
      lastSig = await sendAndConfirmTransaction(
        getDlmmConnection(),
        tx,
        [params.user],
        { skipPreflight: false, maxRetries: 2 },
      );
    }

    return { success: true, signature: lastSig };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Remove liquidity failed',
    };
  }
}

export async function estimatePositionInRange(
  poolAddress: string,
  minBinId: number,
  maxBinId: number,
): Promise<{ inRange: boolean; activeBinId: number }> {
  const active = await getActiveBinInfo(poolAddress);
  const inRange = active.binId >= minBinId && active.binId <= maxBinId;
  return { inRange, activeBinId: active.binId };
}
