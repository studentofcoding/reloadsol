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
import { chainSwitchTarget } from "@/utils/network-switch";
import {
  chromeConnect,
  chromeGhost,
  insightPress,
} from "@/components/insight/insight-ui";
import SegPillList from "@/components/ui/SegPillList";

/** Path at click time — usePathname here would break static prerender of /chart/[token]. */
function currentPath(): string {
  return typeof window === "undefined" ? "" : window.location.pathname;
}

interface UniversalWalletButtonProps {
  variant?: "default" | "jupiter";
  connectLabel?: string;
  /** Light Header chrome vs dark in-page controls. Network logic is unchanged. */
  surface?: "default" | "chrome";
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default function UniversalWalletButton({
  variant = "default",
  connectLabel = "Connect Wallet",
  surface = "default",
}: UniversalWalletButtonProps) {
  const isChrome = surface === "chrome";
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

  const networkToggle = showRhToggle ? (
    isChrome ? (
      <SegPillList
        variant="chrome"
        ariaLabel="Network"
        value={network}
        onSelect={(next) => {
          if (next === 'sol') {
            setNetwork('sol')
            router.push(chainSwitchTarget(currentPath(), 'sol'))
            return
          }
          setNetwork('robinhood', { skipCoerce: true })
          void rh.connect().catch(() => {
            /* rh.error surfaces below */
          })
          router.push(chainSwitchTarget(currentPath(), 'robinhood'))
        }}
        options={[
          {
            id: 'sol',
            label: (
              <>
                <span className="md:hidden">Sol</span>
                <span className="hidden md:inline">Solana</span>
              </>
            ),
          },
          {
            id: 'robinhood',
            label: (
              <>
                <span className="md:hidden">RH</span>
                <span className="hidden md:inline">Robinhood</span>
              </>
            ),
          },
        ]}
      />
    ) : (
      <SegPillList
        variant="insight"
        ariaLabel="Network"
        className="overflow-hidden rounded-lg border border-gray-600 text-xs"
        value={network}
        onSelect={(next) => {
          if (next === 'sol') {
            setNetwork('sol')
            router.push(chainSwitchTarget(currentPath(), 'sol'))
            return
          }
          setNetwork('robinhood', { skipCoerce: true })
          void rh.connect().catch(() => {
            /* rh.error surfaces below */
          })
          router.push(chainSwitchTarget(currentPath(), 'robinhood'))
        }}
        options={[
          { id: 'sol', label: 'Solana' },
          { id: 'robinhood', label: 'Robinhood' },
        ]}
      />
    )
  ) : null;

  return (
    <div
      className={
        isChrome
          ? "inline-flex items-center gap-1.5"
          : "inline-flex flex-col items-stretch gap-1.5"
      }
    >
      {networkToggle}

      {network === "sol" ? (
        connected ? (
          <div className="flex items-center gap-1.5">
            <UnifiedWalletButton
              currentUserClassName={
                isChrome
                  ? "bg-neutral-900 text-white px-3 py-1.5 rounded-full font-medium text-xs"
                  : "bg-black hover:bg-gray-800 text-white px-4 py-2 rounded-lg font-medium transition-colors border border-gray-600"
              }
            />
            <button
              type="button"
              onClick={() => void handleDisconnect()}
              disabled={disconnecting}
              title="Disconnect Solana wallet"
              className={
                isChrome
                  ? `${chromeGhost} disabled:cursor-not-allowed disabled:opacity-50`
                  : `px-2.5 py-2 rounded-lg font-semibold border border-gray-600 text-gray-300 ${insightPress} fine-hover:bg-gray-800 fine-hover:text-white disabled:opacity-50 disabled:cursor-not-allowed text-xs`
              }
            >
              {disconnecting ? "…" : "Disconnect"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className={
              isChrome
                ? chromeConnect
                : `flex items-center justify-center space-x-2 px-3 py-2 rounded-lg font-semibold ${insightPress} border bg-white fine-hover:bg-gray-100 text-black border-gray-300 shadow-lg`
            }
          >
            {connecting ? (
              <>
                <div
                  className={`h-3.5 w-3.5 rounded-full border-2 ${
                    isChrome
                      ? "border-white/30 border-t-white"
                      : "border-gray-400 border-t-black"
                  } animate-spin`}
                />
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
              className={
                isChrome
                  ? `${chromeConnect} font-mono`
                  : `bg-black fine-hover:bg-gray-800 text-white px-4 py-2 rounded-lg font-medium border border-gray-600 font-mono text-sm ${insightPress}`
              }
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
              className={
                isChrome
                  ? `${chromeGhost} disabled:cursor-not-allowed disabled:opacity-50`
                  : `px-2.5 py-2 rounded-lg font-semibold border border-gray-600 text-gray-300 ${insightPress} fine-hover:bg-gray-800 fine-hover:text-white disabled:opacity-50 disabled:cursor-not-allowed text-xs`
              }
            >
              {disconnecting ? "…" : "Disconnect"}
            </button>
          </div>
          {rh.error ? (
            <span className="text-xs text-red-400 max-w-[180px]">{rh.error}</span>
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
            className={
              rh.connecting
                ? isChrome
                  ? `${chromeGhost} cursor-not-allowed opacity-50`
                  : "flex items-center justify-center px-3 py-2 rounded-lg font-semibold border bg-gray-600 text-gray-400 cursor-not-allowed border-gray-500"
                : isChrome
                  ? chromeConnect
                  : `flex items-center justify-center px-3 py-2 rounded-lg font-semibold border bg-white fine-hover:bg-gray-100 text-black border-gray-300 ${insightPress}`
            }
          >
            {!rh.hasProvider
              ? "No Rabby"
              : rh.connecting
                ? "Connecting…"
                : "Connect Rabby"}
          </button>
          {rh.error || rhHint ? (
            <span className="text-xs text-red-400 max-w-[180px]">
              {rh.error ?? rhHint}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
