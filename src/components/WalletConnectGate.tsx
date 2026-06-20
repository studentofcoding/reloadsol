'use client';

import React from 'react';
import TrendingTokens from '@/components/TrendingTokens';
import UniversalWalletButton from '@/components/UniversalWalletButton';
import { useWalletAddress } from '@/components/WalletProvider';
import { useUnifiedWalletContext } from '@jup-ag/wallet-adapter';

type WalletConnectGateProps = {
  children: React.ReactNode;
  title?: string;
  description?: string;
  connectLabel?: string;
  showTrending?: boolean;
};

/** Blocks content until a Solana wallet is connected. */
export default function WalletConnectGate({
  children,
  title = 'Catch the trending token with our platform',
  description,
  connectLabel = 'Check now',
  showTrending = true,
}: WalletConnectGateProps) {
  const address = useWalletAddress();
  const { setShowModal } = useUnifiedWalletContext();

  if (address) {
    return <>{children}</>;
  }

  const openWallet = () => setShowModal(true);

  return (
    <div
      className={`grid grid-cols-1 gap-8 max-w-6xl mx-auto ${
        showTrending ? 'lg:grid-cols-3' : 'lg:grid-cols-1'
      }`}
    >
      {showTrending ? (
        <div className="lg:col-span-1">
          <TrendingTokens
            preview
            onSelectToken={openWallet}
            onConnectRequest={openWallet}
          />
        </div>
      ) : null}

      <div className={showTrending ? 'lg:col-span-2' : 'lg:col-span-1'}>
        <div className="bg-gray-900/50 rounded-2xl shadow-lg border border-gray-700 p-8 min-h-[420px] flex flex-col justify-center">
          <div className="mx-auto w-full max-w-md text-center">
            <div className="w-16 h-16 mx-auto mb-6 bg-gray-800 border border-gray-600 rounded-full flex items-center justify-center">
              <svg
                className="w-8 h-8 text-white"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            </div>
            <h2 className="text-2xl md:text-3xl font-bold text-white mb-3">
              {title}
            </h2>
            {description ? (
              <p className="text-gray-400 mb-8">{description}</p>
            ) : (
              <p className="text-gray-400 mb-8">
                Buy any token in bulk,
                <br />
                trade faster and smarter with us
              </p>
            )}
            <UniversalWalletButton connectLabel={connectLabel} />
          </div>
        </div>
      </div>
    </div>
  );
}
