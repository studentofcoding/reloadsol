"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  UnifiedWalletButton,
  useUnifiedWallet,
  useUnifiedWalletContext,
} from "@jup-ag/wallet-adapter";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import { useRhEvmWallet } from "@/hooks/useRhEvmWallet";
import { useDisconnectWallet } from "@/components/WalletProvider";

interface UniversalWalletButtonProps {
  variant?: "default" | "jupiter";
  connectLabel?: string;
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default function UniversalWalletButton({
  variant = "default",
  connectLabel = "Connect Wallet",
}: UniversalWalletButtonProps) {
  const { connected, connecting } = useUnifiedWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const rh = useRhEvmWallet();
  const { network, setNetwork, canUseRh } = useAppNetwork();
  const router = useRouter();
  // EVM-only whitelist: show toggle when Rabby is present so they can connect.
  const showRhToggle = canUseRh || rh.hasProvider;
  const [rhHint, setRhHint] = useState<string | null>(null);
  const { disconnectActive, disconnectRh } = useDisconnectWallet();
  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await disconnectActive();
    } finally {
      setDisconnecting(false);
    }
  };

  if (variant === "jupiter") {
    return (
      <UnifiedWalletButton
        buttonClassName="!bg-white hover:!bg-gray-100 !text-black !border !border-gray-300 !rounded-lg !font-semibold !px-3 !py-3"
        currentUserClassName="!bg-black hover:!bg-gray-800 !text-white !border !border-gray-600 !rounded-lg !font-medium !px-4 !py-2"
      />
    );
  }

  return (
    <div className="inline-flex flex-col items-stretch gap-1.5">
      {showRhToggle ? (
        <div className="flex rounded-lg border border-gray-600 overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => {
              setNetwork("sol");
              router.push("/sell/solana");
            }}
            className={`px-2.5 py-1 font-medium ${
              network === "sol"
                ? "bg-white text-black"
                : "bg-black text-gray-400 hover:text-white"
            }`}
          >
            Solana
          </button>
          <button
            type="button"
            onClick={() => {
              setNetwork("robinhood", { skipCoerce: true });
              void rh.connect().catch(() => {
                /* rh.error surfaces below */
              });
              router.push("/sell/robinhood");
            }}
            className={`px-2.5 py-1 font-medium border-l border-gray-600 ${
              network === "robinhood"
                ? "bg-white text-black"
                : "bg-black text-gray-400 hover:text-white"
            }`}
          >
            Robinhood
          </button>
        </div>
      ) : null}

      {network === "sol" ? (
        connected ? (
          <div className="flex items-center gap-1.5">
            <UnifiedWalletButton
              currentUserClassName="bg-black hover:bg-gray-800 text-white px-4 py-2 rounded-lg font-medium transition-colors border border-gray-600"
            />
            <button
              type="button"
              onClick={() => void handleDisconnect()}
              disabled={disconnecting}
              title="Disconnect Solana wallet"
              className="px-2.5 py-2 rounded-lg font-semibold border border-gray-600 text-gray-300 hover:bg-gray-800 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed text-xs"
            >
              {disconnecting ? "…" : "Disconnect"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="flex items-center justify-center space-x-2 px-3 py-2 rounded-lg font-semibold transition-all duration-200 border bg-white hover:bg-gray-100 text-black border-gray-300 shadow-lg hover:shadow-xl"
          >
            {connecting ? (
              <>
                <div className="w-4 h-4 border-2 border-gray-400 border-t-black rounded-full animate-spin" />
                <span>Connecting...</span>
              </>
            ) : (
              <span>{connectLabel}</span>
            )}
          </button>
        )
      ) : rh.address ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void rh.connect()}
              className="bg-black hover:bg-gray-800 text-white px-4 py-2 rounded-lg font-medium border border-gray-600 font-mono text-sm"
              title={rh.address}
            >
              {shortAddr(rh.address)}
              {!rh.isCorrectChain ? " · switch RH" : ""}
            </button>
            <button
              type="button"
              onClick={() => void disconnectRh()}
              disabled={disconnecting}
              title="Disconnect Robinhood wallet"
              className="px-2.5 py-2 rounded-lg font-semibold border border-gray-600 text-gray-300 hover:bg-gray-800 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed text-xs"
            >
              {disconnecting ? "…" : "Disconnect"}
            </button>
          </div>
          {rh.error ? (
            <span className="text-[10px] text-red-400 max-w-[180px]">{rh.error}</span>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => {
              if (!rh.hasProvider) {
                setRhHint("Install / unlock Rabby, then refresh");
                return;
              }
              setRhHint(null);
              void rh.connect().catch(() => {
                /* rh.error surfaces below */
              });
            }}
            disabled={rh.connecting}
            className={`
              flex items-center justify-center px-3 py-2 rounded-lg font-semibold border
              ${
                rh.connecting
                  ? "bg-gray-600 text-gray-400 cursor-not-allowed border-gray-500"
                  : "bg-white hover:bg-gray-100 text-black border-gray-300"
              }
            `}
          >
            {!rh.hasProvider
              ? "No Rabby"
              : rh.connecting
                ? "Connecting…"
                : "Connect Rabby"}
          </button>
          {rh.error || rhHint ? (
            <span className="text-[10px] text-red-400 max-w-[180px]">
              {rh.error ?? rhHint}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
