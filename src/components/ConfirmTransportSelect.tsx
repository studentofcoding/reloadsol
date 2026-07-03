"use client";

import { useState } from "react";
import {
  getConfirmTransport,
  setConfirmTransport,
  isConfirmTransportToggleEnabled,
  getConfirmWsUrl,
  type ConfirmTransport,
} from "@/utils/confirm-transport";

/** Dev-only selector for the swap confirmation transport (API polling vs WS). */
export default function ConfirmTransportSelect({
  disabled = false,
  compact = false,
}: {
  disabled?: boolean;
  /** Small variant for tight layouts (e.g. chart buy modal). */
  compact?: boolean;
}) {
  const [transport, setTransportState] = useState<ConfirmTransport>(() =>
    getConfirmTransport(),
  );

  if (!isConfirmTransportToggleEnabled()) return null;

  const handleChange = (next: ConfirmTransport) => {
    setConfirmTransport(next);
    setTransportState(next);
  };

  const wsHost = getConfirmWsUrl().replace(/^wss?:\/\//, "");

  if (compact) {
    return (
      <div className="col-span-2">
        <label className="text-xs text-yellow-500">
          Confirm Transport (dev)
        </label>
        <select
          value={transport}
          onChange={(e) => handleChange(e.target.value as ConfirmTransport)}
          className="w-full bg-gray-700 border border-yellow-600/40 rounded text-xs px-2 py-1 text-white"
          disabled={disabled}
        >
          <option value="api">API polling (Raptor + RPC)</option>
          <option value="ws">WebSocket ({wsHost})</option>
        </select>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label
        htmlFor="confirmTransport"
        className="block text-sm font-semibold text-yellow-400 uppercase tracking-wide"
      >
        Confirm Transport (dev)
      </label>
      <select
        id="confirmTransport"
        value={transport}
        onChange={(e) => handleChange(e.target.value as ConfirmTransport)}
        className="w-full px-4 py-3 bg-gray-800 border border-yellow-600/40 rounded-xl text-white focus:bg-gray-700 focus:border-yellow-400 transition-all duration-200"
        disabled={disabled}
      >
        <option value="api" className="bg-gray-800">
          API polling (Raptor + RPC)
        </option>
        <option value="ws" className="bg-gray-800">
          WebSocket ({wsHost})
        </option>
      </select>
    </div>
  );
}
