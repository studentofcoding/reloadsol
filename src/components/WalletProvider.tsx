"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  UnifiedWalletProvider,
  useUnifiedWallet,
} from "@jup-ag/wallet-adapter";
import { WalletNotification } from "@/components/WalletNotification";
import { WalletSessionProvider } from "@/components/WalletSessionContext";
import { RpcProvider, useRpc } from "@/contexts/RpcContext";
import { AppNetworkProvider } from "@/contexts/AppNetworkContext";
import { RhWalletModeProvider } from "@/contexts/RhWalletModeContext";
import { TradeProviderProvider } from "@/contexts/TradeProviderContext";
import { useGmgnBoundWallets } from "@/hooks/useGmgnBoundWallets";
import { useRhEvmWallet } from "@/hooks/useRhEvmWallet";
import { isDevWallet, toWalletAddress } from "@/utils/dev-wallet";
import { canUseRobinhoodNetwork, isRhWhitelisted } from "@/utils/rh-whitelist";

type WalletContextState = ReturnType<typeof useUnifiedWallet>;

const WalletContext = createContext<WalletContextState | null>(null);

interface WalletProviderProps {
  children: React.ReactNode;
}

const WALLET_APP_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://reloadsol.app";

/** DEV list or RH_WHITELIST (Sol / Parent / Bound EVM). */
export function useRhNetworkAccess(): boolean {
  const isDevUser = useDevWalletAccess();
  const solAddress = useWalletAddress();
  const rh = useRhEvmWallet();
  const bound = useGmgnBoundWallets();
  return (
    canUseRobinhoodNetwork({
      solAddress,
      evmAddress: rh.address,
      isDevUser,
    }) || isRhWhitelisted(bound.evm)
  );
}

function AppNetworkBridge({ children }: { children: React.ReactNode }) {
  const isDevUser = useDevWalletAccess();
  const canUseRh = useRhNetworkAccess();
  return (
    <AppNetworkProvider isDevUser={isDevUser} canUseRh={canUseRh}>
      <RhWalletModeProvider>{children}</RhWalletModeProvider>
    </AppNetworkProvider>
  );
}

function WalletContextBridge({ children }: { children: React.ReactNode }) {
  const wallet = useUnifiedWallet();

  const walletAddress =
    toWalletAddress(wallet.publicKey) ??
    toWalletAddress(wallet.wallet?.adapter?.publicKey ?? null);

  useEffect(() => {
    const adapterConnected = Boolean(wallet.wallet?.adapter?.connected);
    const isLive = wallet.connected || adapterConnected || Boolean(walletAddress);

    if (isLive) {
      sessionStorage.removeItem("hasDisconnected");
    }
  }, [wallet.connected, wallet.wallet?.adapter?.connected, walletAddress]);

  // Pass through the original wallet context — do not spread/copy it.
  // Spreading breaks connect/sign methods bound to the adapter instance.
  return (
    <WalletContext.Provider value={wallet}>
      <TradeProviderProvider>
        <RpcProvider>
          <ConnectionProvider>
            <WalletSessionProvider>
              <AppNetworkBridge>{children}</AppNetworkBridge>
            </WalletSessionProvider>
          </ConnectionProvider>
        </RpcProvider>
      </TradeProviderProvider>
    </WalletContext.Provider>
  );
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [autoConnect] = useState(
    () =>
      typeof window !== "undefined" &&
      !sessionStorage.getItem("hasDisconnected"),
  );

  const metadata = useMemo(
    () => ({
      name: "ReloadSOL",
      description: "Reload your Solana and trade smarter",
      url: WALLET_APP_URL,
      iconUrls: [`${WALLET_APP_URL}/logo.png`],
    }),
    [],
  );

  const walletConfig = useMemo(
    () => ({
      autoConnect,
      env: "mainnet-beta" as const,
      metadata,
      notificationCallback: WalletNotification,
      walletlistExplanation: {
        href: "https://developers.jup.ag/docs/tool-kits/wallet-kit",
      },
      theme: "dark" as const,
      lang: "en" as const,
    }),
    [autoConnect, metadata],
  );

  return (
    <UnifiedWalletProvider
      wallets={[]}
      config={walletConfig}
      localStorageKey="reloadsol-wallet"
    >
      <WalletContextBridge>{children}</WalletContextBridge>
    </UnifiedWalletProvider>
  );
}

export function useWallet(): WalletContextState {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return context;
}

const ConnectionContext = createContext<
  { connection: import("@solana/web3.js").Connection | null } | undefined
>(undefined);

function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const { connection } = useRpc();

  return (
    <ConnectionContext.Provider value={{ connection }}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection() {
  const ctx = useContext(ConnectionContext);
  if (ctx === undefined) {
    throw new Error("useConnection must be used within a WalletProvider");
  }
  return ctx;
}

/** Resolved base58 address from Jupiter wallet state (all known shapes). */
export function useWalletAddress(): string | null {
  const { publicKey, wallet, connected } = useWallet();

  const adapterConnected = Boolean(wallet?.adapter?.connected);
  if (!connected && !adapterConnected) return null;

  return (
    toWalletAddress(publicKey) ??
    toWalletAddress(wallet?.adapter?.publicKey ?? null)
  );
}

/**
 * True when a dev-listed wallet is connected.
 * Uses adapter.connected as well as context.connected (Jupiter quirk).
 */
export function useDevWalletAccess(): boolean {
  const address = useWalletAddress();
  return address !== null && isDevWallet(address);
}
