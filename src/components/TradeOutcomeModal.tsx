'use client';

import React, { useCallback, useState } from "react";

export type TradeOutcomeOperation = 'buy' | 'sell' | 'close';

export type CloseableAccount = {
  mintAddress: string;
  symbol?: string;
};

export type TradeAmountUnit = 'SOL' | 'ETH' | 'USDC' | 'USDG';

export type TradeOutcomeState = {
  isOpen: boolean;
  success: boolean;
  operation: TradeOutcomeOperation;
  isSimulation?: boolean;
  tokenSymbol?: string;
  mintAddress?: string;
  solAmount?: number;
  /** Unit for solAmount display (default SOL). */
  amountUnit?: TradeAmountUnit;
  error?: string;
  /** Successful 100% sells eligible for rent reclaim (post-sell CTA). */
  closeableAccounts?: CloseableAccount[];
};

const initialState: TradeOutcomeState = {
  isOpen: false,
  success: false,
  operation: 'sell',
};

type TradeOutcomeModalProps = TradeOutcomeState & {
  onClose: () => void;
  onCloseAccounts?: () => void | Promise<void>;
  isClosingAccounts?: boolean;
};

export function useTradeOutcome() {
  const [outcome, setOutcome] = useState<TradeOutcomeState>(initialState);

  const showOutcome = useCallback(
    (next: Omit<TradeOutcomeState, 'isOpen'>) => {
      setOutcome({ ...next, isOpen: true });
    },
    [],
  );

  const hideOutcome = useCallback(() => {
    setOutcome((prev) => ({ ...prev, isOpen: false }));
  }, []);

  return {
    outcome,
    showOutcome,
    hideOutcome,
    outcomeModalProps: {
      ...outcome,
      onClose: hideOutcome,
    },
  };
}

function operationLabel(operation: TradeOutcomeOperation): string {
  switch (operation) {
    case 'buy':
      return 'Buy';
    case 'sell':
      return 'Sell';
    case 'close':
      return 'Close';
    default:
      return 'Trade';
  }
}

function accountLabel(account: CloseableAccount): string {
  if (account.symbol) return account.symbol;
  const m = account.mintAddress;
  return `${m.slice(0, 4)}…${m.slice(-4)}`;
}

export default function TradeOutcomeModal({
  isOpen,
  onClose,
  success,
  operation,
  isSimulation = false,
  tokenSymbol,
  mintAddress,
  solAmount,
  amountUnit = 'SOL',
  error,
  closeableAccounts,
  onCloseAccounts,
  isClosingAccounts = false,
}: TradeOutcomeModalProps) {
  if (!isOpen) return null;

  const modeLabel = isSimulation ? 'Simulation' : 'Live';
  const tokenLabel =
    tokenSymbol ||
    (mintAddress
      ? `${mintAddress.slice(0, 4)}…${mintAddress.slice(-4)}`
      : 'Token');

  const showCloseAccounts =
    success &&
    operation === 'sell' &&
    !isSimulation &&
    (closeableAccounts?.length ?? 0) > 0 &&
    typeof onCloseAccounts === 'function';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div
        className={`relative w-full max-w-md rounded-2xl border p-6 shadow-2xl ${
          success
            ? 'bg-gradient-to-b from-emerald-950/90 to-gray-900/95 border-emerald-500/40'
            : 'bg-gradient-to-b from-red-950/90 to-gray-900/95 border-red-500/40'
        }`}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-400 hover:text-white text-xl leading-none"
          aria-label="Close"
          disabled={isClosingAccounts}
        >
          ×
        </button>

        <div className="text-center">
          <div className="text-5xl mb-3">{success ? '✓' : '✕'}</div>
          <span
            className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full mb-2 ${
              isSimulation
                ? 'bg-purple-500/20 text-purple-200'
                : 'bg-blue-500/20 text-blue-200'
            }`}
          >
            {modeLabel}
          </span>
          <h3
            className={`text-xl font-bold mb-2 ${
              success ? 'text-emerald-100' : 'text-red-100'
            }`}
          >
            {success
              ? `${operationLabel(operation)} successful`
              : `${operationLabel(operation)} failed`}
          </h3>
          <p className="text-gray-300 text-sm mb-1">{tokenLabel}</p>
          {success && typeof solAmount === 'number' ? (
            <p className="text-gray-400 text-sm">
              {operation === 'buy' ? 'Spent' : 'Received'}:{' '}
              <span className="text-white font-mono">
                {solAmount.toFixed(4)} {amountUnit}
              </span>
            </p>
          ) : null}
          {!success && error ? (
            <p className="text-red-300 text-sm mt-3 break-words">{error}</p>
          ) : null}
          {success && operation === 'sell' && isSimulation ? (
            <p className="text-emerald-200/80 text-xs mt-3">
              Position closed — it will disappear from open positions shortly.
            </p>
          ) : null}

          {showCloseAccounts ? (
            <div className="mt-4 text-left rounded-xl border border-emerald-500/30 bg-black/30 px-3 py-3">
              <p className="text-xs text-emerald-200/90 mb-2">
                Empty accounts after 100% sell — reclaim ~0.002 SOL rent each:
              </p>
              <ul className="max-h-28 overflow-y-auto space-y-1 text-sm text-gray-200">
                {closeableAccounts!.map((account) => (
                  <li key={account.mintAddress} className="font-mono text-xs">
                    {accountLabel(account)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="mt-6 space-y-2">
          {showCloseAccounts ? (
            <button
              type="button"
              onClick={() => void onCloseAccounts?.()}
              disabled={isClosingAccounts}
              className="w-full py-2.5 rounded-lg font-medium text-white transition-colors bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-600 disabled:text-gray-400 disabled:cursor-not-allowed"
            >
              {isClosingAccounts
                ? 'Closing accounts…'
                : `Close ${closeableAccounts!.length} account${
                    closeableAccounts!.length === 1 ? '' : 's'
                  }`}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            disabled={isClosingAccounts}
            className={`w-full py-2.5 rounded-lg font-medium text-white transition-colors disabled:opacity-50 ${
              success
                ? 'bg-emerald-600 hover:bg-emerald-500'
                : 'bg-red-600 hover:bg-red-500'
            }`}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
