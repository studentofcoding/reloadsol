"use client";

import { OptimizedImage } from "@/components/OptimizedImage";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Searchable token picker shared by the Buy page (batch token search) and the
 * swap panel (Token address fields).
 *
 * The input text is controlled by the parent (`value`/`onChange`) — on the buy
 * page it is the transient search term, on the swap panel it is the token
 * address field itself. The parent owns the search queries and passes the live
 * results in (`options`); this component owns the dropdown open/close,
 * focus-driven holdings section, holdings filtering, "already picked" state and
 * the no-results fallback.
 */

export type TokenSearchOption = {
  address: string;
  symbol: string;
  name?: string;
  icon?: string;
  /** Holdings rows only: spendable UI amount + USD value. */
  amount?: number;
  usdValue?: number;
};

type TokenSearchBoxProps = {
  value: string;
  onChange: (value: string) => void;
  /** Live search results for the current query. */
  options: TokenSearchOption[];
  /** True while the search query is in flight. */
  isSearching?: boolean;
  /** User holdings shown on focus (and filtered as the user types). */
  holdings?: TokenSearchOption[];
  /** Header for the holdings section when the box is empty. */
  holdingsTitle?: string;
  /** Addresses already added/picked — shown as "Added" and disabled. */
  picked?: string[];
  /** Called when a holding or search result is picked. */
  onPick: (token: TokenSearchOption) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Show the holdings section when the box is focused (default true). */
  openHoldingsOnFocus?: boolean;
};

function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export default function TokenSearchBox({
  value,
  onChange,
  options,
  isSearching,
  holdings = [],
  holdingsTitle = "Your tokens",
  picked = [],
  onPick,
  placeholder,
  disabled,
  openHoldingsOnFocus = true,
}: TokenSearchBoxProps) {
  const [open, setOpen] = useState(false);
  // Suppress the auto-open (a fresh query returned options) right after a pick
  // so the dropdown does not re-appear when the parent fills the field with
  // the chosen address.
  const suppressRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(false);

  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  const pickedSet = useMemo(
    () => new Set(picked.map((p) => p.toLowerCase())),
    [picked],
  );

  const matchingHoldings = useMemo(
    () =>
      holdings.filter(
        (h) =>
          !lower ||
          h.name?.toLowerCase().includes(lower) ||
          h.symbol.toLowerCase().includes(lower) ||
          h.address.toLowerCase().includes(lower),
      ),
    [holdings, lower],
  );

  // Close on outside click.
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        rootRef.current &&
        !rootRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
        focusedRef.current = false;
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        focusedRef.current = false;
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const isPicked = (address: string) => pickedSet.has(address.toLowerCase());

  const pick = (token: TokenSearchOption) => {
    suppressRef.current = value;
    setOpen(false);
    onPick(token);
  };

  // While focused, a completed query with results auto-opens the dropdown.
  const autoOpen =
    focusedRef.current &&
    openHoldingsOnFocus !== false &&
    trimmed.length > 0 &&
    options.length > 0 &&
    !isSearching &&
    suppressRef.current !== value;

  const showHoldingsHeader = !trimmed;
  const noResults =
    open &&
    trimmed.length > 0 &&
    !isSearching &&
    options.length === 0 &&
    matchingHoldings.length === 0 &&
    suppressRef.current !== value;

  const showPanel =
    !disabled &&
    (open || autoOpen) &&
    (matchingHoldings.length > 0 || options.length > 0 || noResults);

  return (
    <div className="relative" ref={rootRef}>
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            if (suppressRef.current !== null && e.target.value !== suppressRef.current) {
              suppressRef.current = null;
            }
          }}
          onFocus={() => {
            focusedRef.current = true;
            if (openHoldingsOnFocus && holdings.length > 0) setOpen(true);
          }}
          onBlur={() => {
            // Delay so click handlers on options still fire.
            window.setTimeout(() => {
              focusedRef.current = false;
            }, 120);
          }}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full pl-4 pr-4 py-3 bg-gray-800 border border-gray-600 rounded-xl shadow-inner text-white placeholder-gray-400 focus:bg-gray-700 focus:border-gray-400 transition-all duration-200"
        />
        <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
          <svg
            className="h-5 w-5 text-gray-400"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
              clipRule="evenodd"
            />
          </svg>
        </div>
      </div>

      {showPanel && (
        <div className="absolute z-20 mt-2 w-full bg-gray-900/50 border border-gray-700 rounded-xl shadow-lg max-h-72 overflow-y-auto">
          {/* Holdings section */}
          {matchingHoldings.length > 0 && (
            <>
              {showHoldingsHeader && (
                <div className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-700 bg-gray-800">
                  {holdingsTitle} ({holdings.length})
                </div>
              )}
              {matchingHoldings.map((token) => {
                const already = isPicked(token.address);
                return (
                  <button
                    key={`held-${token.address}`}
                    type="button"
                    disabled={already}
                    onClick={() => (already ? undefined : pick(token))}
                    className={`flex items-center w-full px-4 py-2 text-left transition-all ${
                      already
                        ? "bg-gray-700 text-gray-400 cursor-not-allowed"
                        : "hover:bg-gray-800 text-white"
                    }`}
                  >
                    {token.icon && (
                      <OptimizedImage
                        src={token.icon}
                        alt={token.symbol ?? "Token"}
                        className="w-6 h-6 mr-3 rounded-full"
                      />
                    )}
                    <div className="flex-1">
                      <div className="font-semibold flex items-center">
                        {token.name}
                        <span className="text-xs text-gray-400 ml-1">
                          ({token.symbol})
                        </span>
                        {already && (
                          <span className="ml-2 text-xs bg-gray-600 text-gray-300 px-2 py-0.5 rounded">
                            Added
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 font-mono truncate flex justify-between gap-2">
                        <span className="truncate">
                          {shortAddress(token.address)}
                        </span>
                        {token.amount != null && (
                          <span className="shrink-0 text-gray-300">
                            {token.amount.toLocaleString(undefined, {
                              maximumFractionDigits: 6,
                            })}
                            {(token.usdValue ?? 0) > 0 && (
                              <span className="ml-1 text-green-400">
                                (${token.usdValue!.toFixed(2)})
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </>
          )}

          {/* Live search results */}
          {options.length > 0 && (
            <>
              {matchingHoldings.length > 0 && (
                <div className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-700 bg-gray-800">
                  Search Results
                </div>
              )}
              {options.map((token) => (
                <button
                  key={`search-${token.address}`}
                  type="button"
                  className="flex items-center w-full px-4 py-2 hover:bg-gray-800 text-left text-white"
                  onClick={() => pick(token)}
                >
                  {token.icon && (
                    <OptimizedImage
                      src={token.icon}
                      alt={token.symbol ?? "Token"}
                      className="w-6 h-6 mr-3 rounded-full"
                    />
                  )}
                  <div className="flex-1">
                    <div className="font-semibold">
                      {token.name}{" "}
                      <span className="text-xs text-gray-400">
                        ({token.symbol})
                      </span>
                    </div>
                    <div className="text-xs text-gray-400 font-mono truncate">
                      {shortAddress(token.address)}
                    </div>
                  </div>
                </button>
              ))}
            </>
          )}

          {noResults && (
            <div className="px-4 py-4 text-gray-400 text-sm">
              No results found.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
