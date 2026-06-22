"use client";

import { useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet, useWalletAddress } from "@/components/WalletProvider";

export function useResolvedWalletPublicKey() {
  const { publicKey, connected } = useWallet();
  const walletAddress = useWalletAddress();

  const resolvedPublicKey = useMemo(() => {
    if (publicKey) return publicKey;
    if (!walletAddress) return null;
    try {
      return new PublicKey(walletAddress);
    } catch {
      return null;
    }
  }, [publicKey, walletAddress]);

  const isWalletReady = Boolean(walletAddress && resolvedPublicKey);

  return {
    publicKey: resolvedPublicKey,
    walletAddress,
    connected,
    isWalletReady,
  };
}
