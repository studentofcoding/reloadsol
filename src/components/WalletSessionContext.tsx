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

export type WalletSessionStatus =
  | 'idle'
  | 'checking'
  | 'signing'
  | 'ready'
  | 'error';

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
    setStatus('checking');
    setError(null);

    try {
      const current = await getWalletSessionStatus();
      if (current.authenticated && current.address === address) {
        setSessionAddress(address);
        setStatus('ready');
        dispatchSessionReady(address);
        return;
      }

      setStatus('signing');
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

  const walletCanSign = address ? canSign : false;

  useEffect(() => {
    if (!address || !walletCanSign) {
      return;
    }

    const addressChanged =
      lastAddressRef.current !== null &&
      lastAddressRef.current !== address;

    lastAddressRef.current = address;

    if (!canSignMessages({ signMessage, adapter })) {
      return;
    }

    void (async () => {
      if (addressChanged) {
        signingRef.current = false;
        setStatus('checking');
        setSessionAddress(null);
        setError(null);
        try {
          await clearWalletSession();
        } catch {
          /* continue to sign in for new wallet */
        }
      } else {
        setStatus('checking');
      }

      await runSignIn();
    })();
  }, [address, signMessage, adapter, runSignIn, walletCanSign]);

  const value: WalletSessionContextValue = {
    status: !address ? 'idle' : !walletCanSign ? 'error' : status,
    error: !address
      ? null
      : !walletCanSign
        ? 'This wallet cannot sign messages. Try Phantom or Solflare.'
        : error,
    sessionAddress: address ? sessionAddress : null,
    canSign: walletCanSign,
    signIn: runSignIn,
  };

  return (
    <WalletSessionContext.Provider value={value}>
      {children}
    </WalletSessionContext.Provider>
  );
}
