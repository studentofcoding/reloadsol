"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  HARDCODED_WALLET_STANDARDS,
  UnifiedWalletProvider,
  useUnifiedWallet,
} from "@jup-ag/wallet-adapter";
import { WalletNotification } from "@/components/WalletNotification";
import { WalletSessionProvider } from "@/components/WalletSessionContext";
import { RpcProvider, useRpc } from "@/contexts/RpcContext";
import { AppNetworkProvider, useAppNetwork } from "@/contexts/AppNetworkContext";
import { RhWalletModeProvider } from "@/contexts/RhWalletModeContext";
import { TradeProviderProvider } from "@/contexts/TradeProviderContext";
import { useGmgnBoundWallets } from "@/hooks/useGmgnBoundWallets";
import { useRhEvmWallet } from "@/hooks/useRhEvmWallet";
import { isDevWallet, toWalletAddress } from "@/utils/dev-wallet";
import { canUseRobinhoodNetwork, isRhWhitelisted } from "@/utils/rh-whitelist";
import { shouldAutoConnectWallet } from "@/utils/wallet-auto-connect";

const WALLET_STORAGE_KEY = "reloadsol-wallet";

type WalletContextState = ReturnType<typeof useUnifiedWallet>;

const WalletContext = createContext<WalletContextState | null>(null);

interface WalletProviderProps {
  children: React.ReactNode;
}

const WALLET_APP_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://reloadsol.app";

/**
 * Whether the Robinhood network is usable at all.
 *
 * The two wallets are fully independent — no Solana wallet is required to
 * trade on Robinhood. Any user with a Rabby (or EVM) provider present can
 * use the RH network; dev/whitelist users retain access even without a
 * provider installed (e.g. bound-wallet trades).
 */
export function useRhNetworkAccess(): boolean {
  const solAddress = useWalletAddress();
  const rh = useRhEvmWallet();
  const bound = useGmgnBoundWallets();
  const isRhDev =
    Boolean(rh.address) && isDevWallet(rh.address, "robinhood");
  return (
    rh.hasProvider ||
    canUseRobinhoodNetwork({
      solAddress,
      evmAddress: rh.address,
      isDevUser: isRhDev,
    }) ||
    isRhWhitelisted(bound.evm)
  );
}

function AppNetworkBridge({ children }: { children: React.ReactNode }) {
  const solAddress = useWalletAddress();
  const evmAddress = useRhWalletAddress();
  const isDevUser =
    (solAddress !== null && isDevWallet(solAddress, "sol")) ||
    (evmAddress !== null && isDevWallet(evmAddress, "robinhood"));
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
  // ponytail: defer localStorage read to effect — reading in useState initializer
  // mismatches SSR (false) vs client (true) and triggers React #418.
  const [autoConnect, setAutoConnect] = useState(false);
  useEffect(() => {
    let prior: string | null = null;
    try {
      prior = localStorage.getItem(WALLET_STORAGE_KEY);
    } catch {
      prior = null;
    }
    setAutoConnect(
      shouldAutoConnectWallet({
        hasDisconnected: Boolean(sessionStorage.getItem("hasDisconnected")),
        priorWalletName: prior,
      }),
    );
  }, []);

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
      // Show Phantom / popular wallets even when Wallet Standard is empty
      // (otherwise the modal only shows the "New here?" onboarding screen).
      hardcodedWallets: HARDCODED_WALLET_STANDARDS,
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
      localStorageKey={WALLET_STORAGE_KEY}
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

/**
 * Disconnect the wallet for the given chain (or the active chain by default).
 * Sol: calls the Jupiter adapter's disconnect (from useUnifiedWallet).
 * Robinhood: clears the Rabby/EVM wallet state via useRhEvmWallet().disconnect.
 */
export function useDisconnectWallet() {
  const { disconnect: disconnectSol, connected: solConnected } = useWallet();
  const rh = useRhEvmWallet();
  const { network } = useAppNetwork();

  const disconnectActive = useCallback(async () => {
    if (network === "robinhood") {
      await rh.disconnect();
    } else {
      if (solConnected) await disconnectSol();
      // Also clear RH state if it was connected — disconnecting one chain
      // should not leave the other half-connected in the same UI session.
      await rh.disconnect();
    }
  }, [network, solConnected, disconnectSol, rh]);

  return {
    disconnectActive,
    solConnected,
    rhConnected: Boolean(rh.address),
    disconnectSol: disconnectSol,
    disconnectRh: rh.disconnect,
  };
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
 * Resolved EVM (RH parent) address from the Rabby/EVM wallet. Null when no
 * EVM wallet is connected or the provider isn't installed. Mirrors
 * `useWalletAddress()` but for the Robinhood side.
 */
export function useRhWalletAddress(): string | null {
  const rh = useRhEvmWallet();
  return rh.address ?? null;
}

/**
 * True when a chain-correct dev wallet is connected (Sol pubkey on Sol,
 * RH deployer on Robinhood). Does not use the other chain's wallet.
 */
export function useDevWalletAccess(): boolean {
  const { network } = useAppNetwork();
  const solAddress = useWalletAddress();
  const evmAddress = useRhWalletAddress();
  if (network === "robinhood") {
    return evmAddress !== null && isDevWallet(evmAddress, "robinhood");
  }
  return solAddress !== null && isDevWallet(solAddress, "sol");
}

/** Same as `useDevWalletAccess` — kept for existing call sites. */
export function useDevUserAccess(): boolean {
  return useDevWalletAccess();
}
