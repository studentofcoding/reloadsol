import { encodeFunctionData, type Address, type Hash } from 'viem';
import { CHAINS, type SupportedChainId, txUrl } from './config';
import { npmAbi } from './abis';
import { getHotWalletAddress, getPublicClient, getWalletClient } from './clients';
import { getPosition } from './positions';
import { humanToFloat } from './tokens';
import { getTokenPriceUsd } from './dexscreener';

export type CloseResult = {
  hash: Hash;
  tokenId: bigint;
  amount0: bigint;
  amount1: bigint;
  amount0Human: number;
  amount1Human: number;
  withdrawalUsd: number;
  feesPortionUsd: number;
  txLink: string;
  token0: Address;
  token1: Address;
  symbol0: string;
  symbol1: string;
};

const MAX_UINT128 = (BigInt(1) << BigInt(128)) - BigInt(1);

function shortErr(e: unknown): string {
  if (!(e instanceof Error)) return String(e).slice(0, 280);
  const any = e as Error & { shortMessage?: string; details?: string; cause?: unknown };
  const parts = [any.shortMessage, any.message, any.details].filter(Boolean);
  return parts.join(' | ').slice(0, 320);
}

export async function closePosition(
  chainId: SupportedChainId,
  tokenId: bigint,
  protocol: 'v3' | 'v4' = 'v3',
): Promise<CloseResult> {
  if (protocol === 'v4') {
    const { closeV4Position } = await import('./v4');
    const r = await closeV4Position(chainId, tokenId);
    return {
      hash: r.hash,
      tokenId: r.tokenId,
      amount0: r.amount0,
      amount1: r.amount1,
      amount0Human: r.amount0Human,
      amount1Human: r.amount1Human,
      withdrawalUsd: r.withdrawalUsd,
      feesPortionUsd: r.feesPortionUsd,
      txLink: r.txLink,
      token0: r.token0,
      token1: r.token1,
      symbol0: r.symbol0,
      symbol1: r.symbol1,
    };
  }

  // Re-read live position (liquidity can change; stale liq is a common close fail — not slippage)
  const pos = await getPosition(chainId, tokenId);
  if (!pos) throw new Error(`Position #${tokenId} not found or already empty`);

  const npm = CHAINS[chainId].npm;
  const recipient = getHotWalletAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const client = getPublicClient(chainId);
  const wallet = getWalletClient(chainId);

  // Fresh on-chain liquidity (authoritative)
  let liveLiq = pos.liquidity;
  try {
    const raw = await client.readContract({
      address: npm,
      abi: npmAbi,
      functionName: 'positions',
      args: [tokenId],
    });
    liveLiq = raw[7] as bigint;
  } catch {
    /* use pos.liquidity */
  }

  console.log(
    `[close v3] #${tokenId} liveLiq=${liveLiq} owed0=${pos.tokensOwed0} owed1=${pos.tokensOwed1}`,
  );

  // amount0Min/amount1Min = 0 → not a slippage-protected close (by design for meme/single-sided)
  const decreaseCall =
    liveLiq > BigInt(0)
      ? encodeFunctionData({
          abi: npmAbi,
          functionName: 'decreaseLiquidity',
          args: [
            {
              tokenId,
              liquidity: liveLiq,
              amount0Min: BigInt(0),
              amount1Min: BigInt(0),
              deadline,
            },
          ],
        })
      : null;

  const collectCall = encodeFunctionData({
    abi: npmAbi,
    functionName: 'collect',
    args: [
      {
        tokenId,
        recipient,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
    ],
  });

  const safeCalls = decreaseCall ? [decreaseCall, collectCall] : [collectCall];

  // Retries: up to 3 rounds × (multicall → sequential decrease/collect)
  const { withRetries } = await import('./retry');
  const hash = await withRetries(
    async (round) => {
      // Fresh liquidity each round
      let liq = liveLiq;
      try {
        const raw = await client.readContract({
          address: npm,
          abi: npmAbi,
          functionName: 'positions',
          args: [tokenId],
        });
        liq = raw[7] as bigint;
      } catch {
        /* keep */
      }
      const dl = BigInt(Math.floor(Date.now() / 1000) + 1800);
      const dec =
        liq > BigInt(0)
          ? encodeFunctionData({
              abi: npmAbi,
              functionName: 'decreaseLiquidity',
              args: [
                {
                  tokenId,
                  liquidity: liq,
                  amount0Min: BigInt(0),
                  amount1Min: BigInt(0),
                  deadline: dl,
                },
              ],
            })
          : null;
      const col = encodeFunctionData({
        abi: npmAbi,
        functionName: 'collect',
        args: [
          {
            tokenId,
            recipient,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
          },
        ],
      });
      const calls = dec ? [dec, col] : [col];
      console.log(`[close v3] round ${round} liq=${liq}`);

      try {
        await client.simulateContract({
          address: npm,
          abi: npmAbi,
          functionName: 'multicall',
          args: [calls],
          account: recipient,
        });
        const h = await wallet.writeContract({
          address: npm,
          abi: npmAbi,
          functionName: 'multicall',
          args: [calls],
          account: wallet.account!,
          chain: wallet.chain,
          gas: BigInt('900000'),
        });
        const receipt = await client.waitForTransactionReceipt({ hash: h });
        if (receipt.status !== 'success') throw new Error(`multicall reverted ${h}`);
        return h;
      } catch (e1) {
        console.warn(`[close v3] multicall fail r${round}:`, shortErr(e1));
        // Sequential fallback
        if (liq > BigInt(0)) {
          const raw = await client.readContract({
            address: npm,
            abi: npmAbi,
            functionName: 'positions',
            args: [tokenId],
          });
          const liq2 = raw[7] as bigint;
          if (liq2 > BigInt(0)) {
            const h1 = await wallet.writeContract({
              address: npm,
              abi: npmAbi,
              functionName: 'decreaseLiquidity',
              args: [
                {
                  tokenId,
                  liquidity: liq2,
                  amount0Min: BigInt(0),
                  amount1Min: BigInt(0),
                  deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
                },
              ],
              account: wallet.account!,
              chain: wallet.chain,
              gas: BigInt('500000'),
            });
            const r1 = await client.waitForTransactionReceipt({ hash: h1 });
            if (r1.status !== 'success') throw new Error(`decrease reverted ${h1}`);
          }
        }
        const h2 = await wallet.writeContract({
          address: npm,
          abi: npmAbi,
          functionName: 'collect',
          args: [
            {
              tokenId,
              recipient,
              amount0Max: MAX_UINT128,
              amount1Max: MAX_UINT128,
            },
          ],
          account: wallet.account!,
          chain: wallet.chain,
          gas: BigInt('400000'),
        });
        const r2 = await client.waitForTransactionReceipt({ hash: h2 });
        if (r2.status !== 'success') throw new Error(`collect reverted ${h2}`);
        return h2;
      }
    },
    {
      times: 3,
      backoffMs: 1200,
      label: 'close-v3',
      shouldRetry: (err) => {
        const m = err instanceof Error ? err.message : String(err);
        return !/not found|already empty|not owner|ERC721/i.test(m);
      },
    },
  );

  // Best-effort burn NFT shell
  try {
    const burnHash = await wallet.writeContract({
      address: npm,
      abi: npmAbi,
      functionName: 'burn',
      args: [tokenId],
      account: wallet.account!,
      chain: wallet.chain,
      gas: BigInt('200000'),
    });
    await client.waitForTransactionReceipt({ hash: burnHash });
  } catch {
    /* NFT may remain with 0 liquidity — OK */
  }

  const amount0 = pos.amount0 + pos.tokensOwed0;
  const amount1 = pos.amount1 + pos.tokensOwed1;
  const a0 = humanToFloat(amount0, pos.decimals0);
  const a1 = humanToFloat(amount1, pos.decimals1);
  const [p0, p1] = await Promise.all([
    getTokenPriceUsd(chainId, pos.token0),
    getTokenPriceUsd(chainId, pos.token1),
  ]);
  const withdrawalUsd = a0 * (p0 ?? 0) + a1 * (p1 ?? 0);
  const feesPortionUsd = pos.unclaimedFeesUsd;

  return {
    hash,
    tokenId,
    amount0,
    amount1,
    amount0Human: a0,
    amount1Human: a1,
    withdrawalUsd,
    feesPortionUsd,
    txLink: txUrl(chainId, hash),
    token0: pos.token0,
    token1: pos.token1,
    symbol0: pos.symbol0,
    symbol1: pos.symbol1,
  };
}

export type ClaimFeesResult = {
  protocol: 'v3' | 'v4';
  hash: Hash;
  tokenId: bigint;
  feesUsd: number;
  amount0Human: number;
  amount1Human: number;
  symbol0: string;
  symbol1: string;
  txLink: string;
};

/**
 * Collect unclaimed fees only (position stays open).
 * v3: NPM collect · v4: POSM decrease(0)+take
 */
export async function claimFees(
  chainId: SupportedChainId,
  tokenId: bigint,
  protocol: 'v3' | 'v4' = 'v3',
): Promise<ClaimFeesResult> {
  if (protocol === 'v4') {
    const { claimV4Fees } = await import('./v4');
    const r = await claimV4Fees(chainId, tokenId);
    return {
      protocol: 'v4',
      hash: r.hash,
      tokenId: r.tokenId,
      feesUsd: r.feesUsd,
      amount0Human: r.amount0Human,
      amount1Human: r.amount1Human,
      symbol0: r.symbol0,
      symbol1: r.symbol1,
      txLink: r.txLink,
    };
  }

  const pos = await getPosition(chainId, tokenId);
  if (!pos) throw new Error(`Position #${tokenId} not found or empty`);
  if (pos.tokensOwed0 === BigInt(0) && pos.tokensOwed1 === BigInt(0)) {
    throw new Error(`No unclaimed fees on #${tokenId}`);
  }

  const npm = CHAINS[chainId].npm;
  const recipient = getHotWalletAddress();
  const client = getPublicClient(chainId);
  const wallet = getWalletClient(chainId);

  console.log(
    `[claim v3] #${tokenId} owed0=${pos.tokensOwed0} owed1=${pos.tokensOwed1} estUsd=${pos.unclaimedFeesUsd}`,
  );

  const hash = await wallet.writeContract({
    address: npm,
    abi: npmAbi,
    functionName: 'collect',
    args: [
      {
        tokenId,
        recipient,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
    ],
    account: wallet.account!,
    chain: wallet.chain,
    gas: BigInt('400000'),
  });
  await client.waitForTransactionReceipt({ hash });

  return {
    protocol: 'v3',
    hash,
    tokenId,
    feesUsd: pos.unclaimedFeesUsd,
    amount0Human: humanToFloat(pos.tokensOwed0, pos.decimals0),
    amount1Human: humanToFloat(pos.tokensOwed1, pos.decimals1),
    symbol0: pos.symbol0,
    symbol1: pos.symbol1,
    txLink: txUrl(chainId, hash),
  };
}
