"use client";

import { useState } from "react";
import { useUnifiedWallet, useUnifiedWalletContext } from "@jup-ag/wallet-adapter";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import { useRhEvmWallet } from "@/hooks/useRhEvmWallet";
import { useWalletAddress } from "@/components/WalletProvider";

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * Two independent single-wallet choosers: Solana (Jupiter adapter) and
 * Robinhood (Rabby/EVM). There is no parent/bound concept here — each chain
 * has exactly one wallet. The parent page (Home) auto-redirects to
 * /sell/solana or /sell/robinhood once the matching wallet connects.
 */
export default function WalletChooser() {
  const { connected, connecting } = useUnifiedWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const rh = useRhEvmWallet();
  const solAddress = useWalletAddress();
  const { setNetwork } = useAppNetwork();
  const [rhHint, setRhHint] = useState<string | null>(null);

  const solConnected = connected || Boolean(solAddress);

  const connectSolana = () => {
    setNetwork("sol");
    setShowModal(true);
  };

  const connectRobinhood = () => {
    setNetwork("robinhood", { skipCoerce: true });
    if (!rh.hasProvider) {
      setRhHint("Install / unlock Rabby, then try again");
      return;
    }
    setRhHint(null);
    void rh.connect().catch(() => {
      /* rh.error surfaces below */
    });
  };

  return (
    <div className="max-w-3xl mx-auto mb-10 grid grid-cols-1 sm:grid-cols-2 gap-6">
      {/* Solana wallet */}
      <div className="bg-gray-900 rounded-xl p-6 border border-gray-700 flex flex-col items-center text-center">
        <div className="w-12 h-12 bg-gray-700 rounded-lg flex items-center justify-center mb-4">
          <svg className="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a2 2 0 012-2h14a2 2 0 012 2 2 2 0 01-2 2H5a2 2 0 01-2-2zm0-6a2 2 0 012-2h14a2 2 0 012 2 2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-white mb-1">Solana Wallet</h3>
        <p className="text-gray-400 text-sm mb-5">Connect your Solana wallet to buy/sell tokens.</p>
        {solConnected ? (
          <div className="bg-black text-white px-4 py-2 rounded-lg font-mono text-sm border border-gray-600">
            {solAddress ? shortAddr(solAddress) : "Connected"}
            <span className="text-gray-400 text-[10px] ml-1">connected</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={connectSolana}
            disabled={connecting}
            className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-semibold border bg-white hover:bg-gray-100 text-black border-gray-300 disabled:opacity-50"
          >
            {connecting ? (
              <>
                <span className="w-4 h-4 border-2 border-gray-400 border-t-black rounded-full animate-spin" />
                <span>Connecting...</span>
              </>
            ) : (
              <span>Connect Solana</span>
            )}
          </button>
        )}
      </div>

      {/* Robinhood wallet */}
      <div className="bg-gray-900 rounded-xl p-6 border border-gray-700 flex flex-col items-center text-center">
        <div className="w-12 h-12 bg-gray-700 rounded-lg flex items-center justify-center mb-4">
          <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.055-.382-3.016z" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-white mb-1">Robinhood Wallet</h3>
        <p className="text-gray-400 text-sm mb-5">Connect your Robinhood (Rabby) wallet to sell tokens.</p>
        {rh.address ? (
          <div className="bg-black text-white px-4 py-2 rounded-lg font-mono text-sm border border-gray-600">
            {shortAddr(rh.address)}
            <span className="text-gray-400 text-[10px] ml-1">connected</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2 items-center">
            <button
              type="button"
              onClick={connectRobinhood}
              disabled={rh.connecting || !rh.hasProvider}
              className={`
                flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-semibold border
                ${
                  !rh.hasProvider
                    ? "bg-gray-700 text-gray-400 cursor-not-allowed border-gray-600"
                    : rh.connecting
                      ? "bg-gray-600 text-gray-400 cursor-not-allowed border-gray-500"
                      : "bg-white hover:bg-gray-100 text-black border-gray-300"
                }
              `}
            >
              {rh.connecting ? (
                <>
                  <span className="w-4 h-4 border-2 border-gray-400 border-t-black rounded-full animate-spin" />
                  <span>Connecting...</span>
                </>
              ) : (
                <span>{rh.hasProvider ? "Connect Robinhood" : "No Rabby"}</span>
              )}
            </button>
            {rh.error || rhHint ? (
              <span className="text-[10px] text-red-400">{rh.error ?? rhHint}</span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}