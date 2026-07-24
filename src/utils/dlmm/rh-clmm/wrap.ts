import type { Address, Hash } from 'viem';
import { CHAINS, type SupportedChainId } from './config';
import { getHotWalletAddress, getPublicClient, getWalletClient } from './clients';
import { formatUnits, getTokenBalance } from './tokens';

/** WETH9 / WBNB: deposit() payable wraps native; withdraw(uint) unwraps */
export const weth9Abi = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const;

/** Keep some native for gas so wrap never empties the wallet */
export const GAS_RESERVE_WEI: Record<SupportedChainId, bigint> = {
  4663: BigInt('500000000000000'), // 0.0005 ETH
};

export function isWrappedNative(chainId: SupportedChainId, token: Address): boolean {
  return CHAINS[chainId].wrapped.toLowerCase() === token.toLowerCase();
}

export async function getNativeBalance(chainId: SupportedChainId): Promise<bigint> {
  const client = getPublicClient(chainId);
  return client.getBalance({ address: getHotWalletAddress() });
}

/** Native that can safely be wrapped (balance − gas reserve, floored at 0) */
export async function getWrappableNative(chainId: SupportedChainId): Promise<bigint> {
  const bal = await getNativeBalance(chainId);
  const reserve = GAS_RESERVE_WEI[chainId];
  return bal > reserve ? bal - reserve : BigInt(0);
}

/**
 * Effective deposit balance for % sizing when deposit token is WETH/WBNB:
 * ERC-20 wrapped + wrappable native.
 * For other tokens: just ERC-20 balance.
 */
export async function getEffectiveDepositBalance(
  chainId: SupportedChainId,
  depositToken: Address,
): Promise<{
  erc20: bigint;
  native: bigint;
  wrappable: bigint;
  effective: bigint;
  isWrapped: boolean;
}> {
  const erc20 = await getTokenBalance(chainId, depositToken);
  const isWrapped = isWrappedNative(chainId, depositToken);
  if (!isWrapped) {
    return { erc20, native: BigInt(0), wrappable: BigInt(0), effective: erc20, isWrapped: false };
  }
  const native = await getNativeBalance(chainId);
  const wrappable = await getWrappableNative(chainId);
  return {
    erc20,
    native,
    wrappable,
    effective: erc20 + wrappable,
    isWrapped: true,
  };
}

export type WrapResult = {
  hash: Hash;
  amount: bigint;
};

/** Wrap native ETH/BNB → WETH/WBNB via deposit() */
export async function wrapNative(
  chainId: SupportedChainId,
  amount: bigint,
): Promise<WrapResult> {
  if (amount <= BigInt(0)) throw new Error('Wrap amount must be > 0');

  const wrappable = await getWrappableNative(chainId);
  if (amount > wrappable) {
    throw new Error(
      `Not enough native to wrap (need ${formatUnits(amount, 18)}, wrappable ${formatUnits(wrappable, 18)} after gas reserve)`,
    );
  }

  const weth = CHAINS[chainId].wrapped;
  const wallet = getWalletClient(chainId);
  const client = getPublicClient(chainId);

  await client.simulateContract({
    address: weth,
    abi: weth9Abi,
    functionName: 'deposit',
    account: getHotWalletAddress(),
    value: amount,
  });

  const hash = await wallet.writeContract({
    address: weth,
    abi: weth9Abi,
    functionName: 'deposit',
    value: amount,
    account: wallet.account!,
    chain: wallet.chain,
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`Wrap tx failed: ${hash}`);
  }

  return { hash, amount };
}

/** Unwrap WETH/WBNB → native via withdraw(amount) */
export async function unwrapNative(
  chainId: SupportedChainId,
  amount: bigint,
): Promise<WrapResult> {
  if (amount <= BigInt(0)) throw new Error('Unwrap amount must be > 0');

  const weth = CHAINS[chainId].wrapped;
  const bal = await getTokenBalance(chainId, weth);
  if (amount > bal) {
    throw new Error(
      `Not enough ${CHAINS[chainId].wrappedSymbol} (have ${formatUnits(bal, 18)}, need ${formatUnits(amount, 18)})`,
    );
  }

  const wallet = getWalletClient(chainId);
  const client = getPublicClient(chainId);

  await client.simulateContract({
    address: weth,
    abi: weth9Abi,
    functionName: 'withdraw',
    args: [amount],
    account: getHotWalletAddress(),
  });

  const hash = await wallet.writeContract({
    address: weth,
    abi: weth9Abi,
    functionName: 'withdraw',
    args: [amount],
    account: wallet.account!,
    chain: wallet.chain,
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`Unwrap tx failed: ${hash}`);
  }

  return { hash, amount };
}

/**
 * Ensure at least `needed` of wrapped token is held as ERC-20.
 * Wraps native shortfall if deposit token is WETH/WBNB.
 * Returns wrap tx info if a wrap was sent.
 */
export async function ensureWrappedBalance(
  chainId: SupportedChainId,
  depositToken: Address,
  needed: bigint,
): Promise<WrapResult | null> {
  if (!isWrappedNative(chainId, depositToken)) return null;

  const erc20 = await getTokenBalance(chainId, depositToken);
  if (erc20 >= needed) return null;

  const shortfall = needed - erc20;
  return wrapNative(chainId, shortfall);
}
