'use client';

import React from 'react';
import { useWalletSessionOptional } from '@/components/WalletSessionContext';

type WalletSignInPromptProps = {
  title?: string;
  description?: string;
  className?: string;
};

export default function WalletSignInPrompt({
  title = 'Sign message to load your trading history',
  description = 'One-time signature per session (up to 7 days). The wallet message expires in 10 minutes — that is normal and not your session length.',
  className = '',
}: WalletSignInPromptProps) {
  const session = useWalletSessionOptional();

  if (!session) {
    return (
      <div
        className={`bg-amber-900/20 border border-amber-600/30 rounded-xl p-4 text-center ${className}`}
      >
        <p className="text-amber-200 text-sm font-medium mb-1">{title}</p>
        <p className="text-gray-400 text-xs">{description}</p>
      </div>
    );
  }

  const { status, error, canSign, signIn } = session;
  const isSigning = status === 'signing';

  return (
    <div
      className={`bg-amber-900/20 border border-amber-600/30 rounded-xl p-4 text-center ${className}`}
    >
      <p className="text-amber-200 text-sm font-medium mb-1">{title}</p>
      <p className="text-gray-400 text-xs mb-3">{description}</p>

      {error ? (
        <p className="text-red-400 text-xs mb-3">{error}</p>
      ) : null}

      {!canSign ? (
        <p className="text-gray-400 text-xs">
          This wallet does not support message signing. Try Phantom or Solflare.
        </p>
      ) : (
        <button
          type="button"
          onClick={() => void signIn()}
          disabled={isSigning}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-amber-600 hover:bg-amber-500 disabled:bg-amber-800 disabled:text-amber-200/70 text-white transition-colors"
        >
          {isSigning ? 'Signing…' : 'Sign in'}
        </button>
      )}
    </div>
  );
}
