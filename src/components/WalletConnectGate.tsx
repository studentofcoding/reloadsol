'use client';

import React from 'react';
import Link from 'next/link';
import UniversalWalletButton from '@/components/UniversalWalletButton';
import { useWalletAddress } from '@/components/WalletProvider';

type WalletConnectGateProps = {
  children: React.ReactNode;
  title?: string;
  description?: string;
};

/** Blocks content until a Solana wallet is connected. */
export default function WalletConnectGate({
  children,
  title = 'Connect your wallet',
  description = 'Connect a wallet to use this page.',
}: WalletConnectGateProps) {
  const address = useWalletAddress();

  if (address) {
    return <>{children}</>;
  }

  return (
    <div className="mx-auto max-w-lg rounded-lg border border-gray-700 bg-gray-900 p-8 text-center text-gray-300">
      <p className="text-lg font-medium text-white">{title}</p>
      <p className="mt-2 text-sm text-gray-400">{description}</p>
      <div className="mt-6 flex justify-center">
        <UniversalWalletButton />
      </div>
      <p className="mt-6 text-xs text-gray-500">
        Or go to{' '}
        <Link href="/sell" className="text-blue-400 underline">
          Reload SOL
        </Link>
      </p>
    </div>
  );
}
