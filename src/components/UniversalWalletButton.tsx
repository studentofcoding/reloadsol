"use client";

import { useEffect, useState } from "react";
import {
  UnifiedWalletButton,
  useUnifiedWallet,
  useUnifiedWalletContext,
} from "@jup-ag/wallet-adapter";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import { useRhWalletMode } from "@/contexts/RhWalletModeContext";
import { useGmgnBoundWallets } from "@/hooks/useGmgnBoundWallets";
import { useRhEvmWallet } from "@/hooks/useRhEvmWallet";
import { resolveRhActiveAddress } from "@/utils/rh-wallet-mode";

interface UniversalWalletButtonProps {
  variant?: "default" | "jupiter";
  connectLabel?: string;
}

/** After this, allow opening the modal even if adapter `connecting` is stuck. */
const CONNECTING_STUCK_MS = 8_000;

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
  const bound = useGmgnBoundWallets();
  const { network, setNetwork, canUseRh } = useAppNetwork();
  const { mode: rhMode, setMode: setRhMode } = useRhWalletMode();
  const activeRh = resolveRhActiveAddress(rhMode, rh.address, bound.evm);
  // EVM-only whitelist: show toggle when Rabby is present so they can connect.
  const showRhToggle = canUseRh || rh.hasProvider;
  const [connectingStuck, setConnectingStuck] = useState(false);
  const [rhHint, setRhHint] = useState<string | null>(null);

  useEffect(() => {
    if (!connecting) {
      setConnectingStuck(false);
      return;
    }
    const t = window.setTimeout(() => setConnectingStuck(true), CONNECTING_STUCK_MS);
    return () => window.clearTimeout(t);
  }, [connecting]);

  const solConnectBlocked = connecting && !connectingStuck;

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
            onClick={() => setNetwork("sol")}
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

      {network === "robinhood" && canUseRh ? (
        <div className="flex rounded-lg border border-gray-600 overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setRhMode("parent")}
            className={`px-2.5 py-1 font-medium ${
              rhMode === "parent"
                ? "bg-white text-black"
                : "bg-black text-gray-400 hover:text-white"
            }`}
            title={rh.address ?? "Connect Rabby"}
          >
            Parent
          </button>
          <button
            type="button"
            onClick={() => setRhMode("bound")}
            className={`px-2.5 py-1 font-medium border-l border-gray-600 ${
              rhMode === "bound"
                ? "bg-white text-black"
                : "bg-black text-gray-400 hover:text-white"
            }`}
            title={bound.evm ?? "No GMGN-bound EVM"}
          >
            Bound
          </button>
        </div>
      ) : null}

      {network === "sol" ? (
        connected ? (
          <UnifiedWalletButton
            currentUserClassName="bg-black hover:bg-gray-800 text-white px-4 py-2 rounded-lg font-medium transition-colors border border-gray-600"
          />
        ) : (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => setShowModal(true)}
              disabled={solConnectBlocked}
              className={`
                flex items-center justify-center space-x-2 px-3 py-2 rounded-lg font-semibold transition-all duration-200 border
                ${
                  solConnectBlocked
                    ? "bg-gray-600 text-gray-400 cursor-not-allowed border-gray-500"
                    : "bg-white hover:bg-gray-100 text-black border-gray-300 shadow-lg hover:shadow-xl"
                }
              `}
            >
              {solConnectBlocked ? (
                <>
                  <div className="w-4 h-4 border-2 border-gray-400 border-t-black rounded-full animate-spin" />
                  <span>Connecting...</span>
                </>
              ) : (
                <span>
                  {connectingStuck ? "Retry connect" : connectLabel}
                </span>
              )}
            </button>
            {connectingStuck ? (
              <span className="text-[10px] text-amber-400 max-w-[180px]">
                Wallet stuck connecting — click to open wallet list
              </span>
            ) : null}
          </div>
        )
      ) : rhMode === "bound" && bound.evm ? (
        <div
          className="bg-black text-white px-4 py-2 rounded-lg font-medium border border-gray-600 font-mono text-sm"
          title={`GMGN bound: ${bound.evm}`}
        >
          {shortAddr(bound.evm)}
          <span className="text-gray-400 text-[10px] ml-1">bound</span>
        </div>
      ) : rh.address ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => void rh.connect()}
            className="bg-black hover:bg-gray-800 text-white px-4 py-2 rounded-lg font-medium border border-gray-600 font-mono text-sm"
            title={rh.address}
          >
            {shortAddr(rh.address)}
            {!rh.isCorrectChain ? " · switch RH" : ""}
            {activeRh ? (
              <span className="text-gray-400 text-[10px] ml-1">parent</span>
            ) : null}
          </button>
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
                : rhMode === "bound"
                  ? "No bound · Connect Rabby"
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
