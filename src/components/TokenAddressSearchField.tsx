"use client";

import { useDeferredValue, useMemo } from "react";
import TokenSearchBox from "@/components/TokenSearchBox";
import { useGmgnTokenSearch } from "@/hooks/useGmgnTokenSearch";
import type { GmgnTradeChain } from "@/utils/gmgn-currencies";
import type { UserToken } from "@/utils/jupiter";

/**
 * Address input with a search dropdown — the swap panel's "Token address"
 * fields. Combines the shared TokenSearchBox dropdown with the live GMGN
 * name/symbol/CA search and the user's holdings for the given chain.
 *
 * Unlike the buy page (transient search term feeding a batch list), here the
 * box holds the actual token address and picking fills it directly.
 */

type TokenAddressSearchFieldProps = {
  chain: GmgnTradeChain;
  value: string;
  onChange: (address: string) => void;
  /** User holdings for the chain (shown on focus + filtered as you type). */
  holdings?: UserToken[];
  /** Optionally mark the current pick as disabled in the dropdown. */
  picked?: string[];
  placeholder?: string;
  label?: string;
  disabled?: boolean;
};

export default function TokenAddressSearchField({
  chain,
  value,
  onChange,
  holdings = [],
  picked = [],
  placeholder,
  label,
  disabled,
}: TokenAddressSearchFieldProps) {
  const deferred = useDeferredValue(value.trim());

  const search = useGmgnTokenSearch(chain, deferred, {
    enabled: value.trim().length > 0,
  });

  const options = useMemo(
    () =>
      (search.data ?? []).map((t) => ({
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        icon: t.icon,
      })),
    [search.data],
  );

  const holdingOptions = useMemo(
    () =>
      holdings.map((t) => ({
        address: t.mintAddress,
        symbol: t.symbol ?? "???",
        name: t.name,
        icon: t.logoURI,
        amount: t.uiAmount,
        usdValue: t.usdValue,
      })),
    [holdings],
  );

  return (
    <TokenSearchBox
      value={value}
      onChange={onChange}
      options={options}
      isSearching={search.isFetching}
      holdings={holdingOptions}
      holdingsTitle="Your holdings"
      picked={picked}
      onPick={(token) => onChange(token.address)}
      placeholder={placeholder ?? "Search by name, symbol, or CA"}
      disabled={disabled}
      openHoldingsOnFocus
    />
  );
}
