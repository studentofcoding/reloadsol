'use client';
import Link from 'next/link';
import UniversalWalletButton from '@/components/UniversalWalletButton';
import {
  useDevWalletAccess,
  useRhWalletAddress,
  useWalletAddress,
} from '@/components/WalletProvider';
import { useAppNetwork } from '@/contexts/AppNetworkContext';

export default function DevRouteGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const { network } = useAppNetwork();
  const solAddress = useWalletAddress();
  const evmAddress = useRhWalletAddress();
  const connectedAddress =
    network === 'robinhood' ? evmAddress : solAddress;
  const isDevUser = useDevWalletAccess();

  if (!connectedAddress) {
    return (
      <div className="mx-auto max-w-lg rounded-lg border border-gray-700 bg-gray-900 p-8 text-center text-gray-300">
        <p className="text-lg font-medium text-white">Connect your wallet</p>
        <p className="mt-2 text-sm text-gray-400">
          Dev tools require a connected {network === 'robinhood'
            ? 'Robinhood'
            : 'Solana'}{' '}
          wallet first.
        </p>
        <div className="mt-6 flex justify-center">
          <UniversalWalletButton />
        </div>
      </div>
    );
  }

  if (!isDevUser) {
    return (
      <div className="mx-auto max-w-lg rounded-lg border border-gray-700 bg-gray-900 p-8 text-center text-gray-300">
        <p className="text-lg font-medium text-white">Dev access required</p>
        <p className="mt-2 text-sm text-gray-400">
          This tool is limited to authorized wallets. Your connected wallet is
          not on the dev allowlist.
        </p>
        <p className="mt-4 text-xs text-gray-500 font-mono break-all">
          {connectedAddress}
        </p>
        <Link
          href="/buy"
          className="mt-6 inline-block rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-gray-100"
        >
          Back to Buy
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
