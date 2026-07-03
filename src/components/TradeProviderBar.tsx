"use client";

import { useTradeProvider } from "@/contexts/TradeProviderContext";
import type { TradeProvider } from "@/utils/trade-provider";

/** Always-visible trade stack selector (Solana Tracker+Raptor vs Shyft). */
export default function TradeProviderBar({
  compact = false,
  disabled = false,
}: {
  compact?: boolean;
  disabled?: boolean;
}) {
  const { provider, setProvider } = useTradeProvider();

  const handleChange = (next: TradeProvider) => {
    setProvider(next);
  };

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-400 whitespace-nowrap">
          Provider
        </label>
        <select
          value={provider}
          onChange={(e) => handleChange(e.target.value as TradeProvider)}
          className="flex-1 min-w-0 bg-gray-800 border border-gray-600 rounded text-xs px-2 py-1.5 text-white"
          disabled={disabled}
        >
          <option value="shyft">Shyft RPC + Shyft API</option>
          <option value="raptor">Solana Tracker + Raptor</option>
        </select>
      </div>
    );
  }

  return (
    <div className="flex flex-col max-w-6xl mx-auto sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 py-2 mb-3 rounded-lg border border-gray-700 bg-gray-900/80">
      <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide whitespace-nowrap">
        Trade Provider
      </span>
      <select
        value={provider}
        onChange={(e) => handleChange(e.target.value as TradeProvider)}
        className="flex-1 min-w-0 bg-gray-800 border border-gray-600 rounded-lg text-sm px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
        disabled={disabled}
      >
        <option value="shyft">
          Shyft RPC + Shyft API (Raptor quotes, Jupiter Lite fallback)
        </option>
        <option value="raptor">Solana Tracker + Raptor</option>
      </select>
    </div>
  );
}
