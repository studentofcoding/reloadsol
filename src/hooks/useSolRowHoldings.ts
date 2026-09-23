"use client";

import { useMemo } from "react";
import { useConnection, useWallet } from "@/components/WalletProvider";
import {
  mergeTokensByMint,
  usdtUiBalance,
} from "@/components/signals/shared/row-holdings";
import { useWalletTokens } from "@/hooks/useWalletTokens";

/** Solana token accounts shared by the signals and mcap-tracker row trade. */
export function useSolRowHoldings(enabled = true) {
  const { connected, publicKey } = useWallet();
  const { connection } = useConnection();
  const walletAddress = connected && publicKey ? publicKey.toBase58() : null;
  const holdings = useWalletTokens({
    connection,
    publicKey,
    walletAddress,
    enabled: enabled && connected && !!publicKey && !!connection,
    includeZeroBalance: false,
  });
  const heldTokenByMint = useMemo(
    () => mergeTokensByMint(holdings.allTokens),
    [holdings.allTokens],
  );

  return {
    allTokens: holdings.allTokens,
    heldTokenByMint,
    usdtUi: usdtUiBalance(heldTokenByMint),
    usdtReady: !walletAddress || holdings.isFetched,
    refetchFresh: holdings.refetchFresh,
  };
}
