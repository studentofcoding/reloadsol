'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useWallet, useWalletAddress } from '@/components/WalletProvider';
import {
  canSignMessages,
  clearWalletSession,
  establishWalletSession,
  getWalletSessionStatus,
} from '@/utils/wallet-session-client';

export type WalletSessionStatus = 'idle' | 'signing' | 'ready' | 'error';

type WalletSessionContextValue = {
  status: WalletSessionStatus;
  error: string | null;
  sessionAddress: string | null;
  canSign: boolean;
  signIn: () => Promise<void>;
};

const WalletSessionContext = createContext<WalletSessionContextValue | null>(
  null,
);

function dispatchSessionReady(address: string) {
  window.dispatchEvent(
    new CustomEvent('reloadsol-wallet-session', {
      detail: { address },
    }),
  );
}

export function useWalletSession(): WalletSessionContextValue {
  const context = useContext(WalletSessionContext);
  if (!context) {
    throw new Error('useWalletSession must be used within WalletSessionProvider');
  }
  return context;
}

/** Optional hook for components that may render outside the provider. */
export function useWalletSessionOptional(): WalletSessionContextValue | null {
  return useContext(WalletSessionContext);
}

export function WalletSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { signMessage, wallet } = useWallet();
  const address = useWalletAddress();
  const [status, setStatus] = useState<WalletSessionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const signingRef = useRef(false);
  const lastAddressRef = useRef<string | null>(null);

  const adapter = wallet?.adapter;
  const canSign = canSignMessages({ signMessage, adapter });

  const runSignIn = useCallback(async () => {
    if (!address) {
      setStatus('idle');
      setSessionAddress(null);
      setError(null);
      return;
    }

    if (!canSignMessages({ signMessage, adapter })) {
      setStatus('error');
      setError('This wallet cannot sign messages. Try Phantom or Solflare.');
      return;
    }

    if (signingRef.current) return;

    signingRef.current = true;
    setStatus('signing');
    setError(null);

    try {
      const current = await getWalletSessionStatus();
      if (current.authenticated && current.address === address) {
        setSessionAddress(address);
        setStatus('ready');
        dispatchSessionReady(address);
        return;
      }

      await establishWalletSession({
        address,
        signMessage,
        adapter,
      });

      setSessionAddress(address);
      setStatus('ready');
      dispatchSessionReady(address);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Wallet sign-in failed';
      setError(message);
      setStatus('error');
      console.warn('Wallet session sign-in failed:', err);
    } finally {
      signingRef.current = false;
    }
  }, [address, signMessage, adapter]);

  useEffect(() => {
    if (!address) {
      // Keep session cookie on disconnect so reconnect does not require re-sign
      setStatus('idle');
      setSessionAddress(null);
      setError(null);
      return;
    }

    if (lastAddressRef.current && lastAddressRef.current !== address) {
      signingRef.current = false;
      void clearWalletSession().catch(() => undefined);
      setStatus('idle');
      setSessionAddress(null);
      setError(null);
    }

    lastAddressRef.current = address;

    if (!canSignMessages({ signMessage, adapter })) {
      setStatus('error');
      setError('This wallet cannot sign messages. Try Phantom or Solflare.');
      return;
    }

    void runSignIn();
  }, [address, signMessage, adapter, runSignIn]);

  const value: WalletSessionContextValue = {
    status,
    error,
    sessionAddress,
    canSign,
    signIn: runSignIn,
  };

  return (
    <WalletSessionContext.Provider value={value}>
      {children}
    </WalletSessionContext.Provider>
  );
}
