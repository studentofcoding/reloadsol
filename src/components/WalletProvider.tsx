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
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { WalletNotification } from "@/components/WalletNotification";
import { createConnection } from "@/utils/connection";

const WalletContext = createContext<WalletContextState | null>(null);

interface WalletProviderProps {
  children: React.ReactNode;
}

function WalletContextBridge({ children }: { children: React.ReactNode }) {
  const wallet = useUnifiedWallet();

  useEffect(() => {
    if (wallet.connected && wallet.publicKey) {
      sessionStorage.removeItem("hasDisconnected");
    }
  }, [wallet.connected, wallet.publicKey]);

  return (
    <WalletContext.Provider value={wallet}>
      <ConnectionProvider>{children}</ConnectionProvider>
    </WalletContext.Provider>
  );
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [autoConnect, setAutoConnect] = useState(false);

  useEffect(() => {
    setAutoConnect(!sessionStorage.getItem("hasDisconnected"));
  }, []);

  const metadata = useMemo(
    () => ({
      name: "ReloadSOL",
      description: "Reload your Solana and trade smarter",
      url:
        typeof window !== "undefined"
          ? window.location.origin
          : "https://v2.reloadsol.xyz",
      iconUrls: ["https://v2.reloadsol.xyz/logo.png"],
    }),
    [],
  );

  return (
    <UnifiedWalletProvider
      wallets={[]}
      config={{
        autoConnect,
        env: "mainnet-beta",
        metadata,
        notificationCallback: WalletNotification,
        walletlistExplanation: {
          href: "https://developers.jup.ag/docs/tool-kits/wallet-kit",
        },
        theme: "dark",
        lang: "en",
      }}
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

const ConnectionContext = createContext<ReturnType<typeof createConnection> | null>(
  null,
);

function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const connection = useMemo(() => createConnection("mainnet"), []);

  return (
    <ConnectionContext.Provider value={connection}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection() {
  const connection = useContext(ConnectionContext);
  if (!connection) {
    throw new Error("useConnection must be used within a WalletProvider");
  }
  return { connection };
}
