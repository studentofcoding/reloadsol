'use client';

import { useEffect, useRef } from 'react';
import { useWallet, useWalletAddress } from '@/components/WalletProvider';
import {
  clearWalletSession,
  establishWalletSession,
  getWalletSessionStatus,
} from '@/utils/wallet-session-client';

/** Signs in with the connected wallet and keeps the httpOnly API session fresh. */
export default function WalletSessionBridge() {
  const wallet = useWallet();
  const address = useWalletAddress();
  const signingRef = useRef(false);

  useEffect(() => {
    if (!address) {
      clearWalletSession().catch(() => undefined);
      return;
    }

    if (signingRef.current) {
      return;
    }

    let cancelled = false;
    signingRef.current = true;

    (async () => {
      try {
        const status = await getWalletSessionStatus();
        if (cancelled) return;

        if (status.authenticated && status.address === address) {
          window.dispatchEvent(
            new CustomEvent('reloadsol-wallet-session', {
              detail: { address },
            }),
          );
          return;
        }

        await establishWalletSession({
          address,
          adapter: wallet.wallet?.adapter ?? null,
        });

        if (!cancelled) {
          window.dispatchEvent(
            new CustomEvent('reloadsol-wallet-session', {
              detail: { address },
            }),
          );
        }
      } catch (error) {
        console.warn('Wallet session sign-in skipped:', error);
      } finally {
        signingRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address, wallet.wallet?.adapter]);

  return null;
}
