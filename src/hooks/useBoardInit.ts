import { useQuery } from "@tanstack/react-query";

export type BoardSectionType = "mcap_tracker" | "watching" | "potential" | "rugged";

export type SignalData = {
  token_address: string;
  label?: string;
  mcap?: number;
  price?: number;
  source?: string;
  market_cap?: number;
  initial_price?: number;
  token_symbol?: string;
  [key: string]: unknown;
};

export type BoardInitData = {
  columns: Record<BoardSectionType, string[]>;
  tokenMcaps: Record<string, number>;
  signals: Record<string, SignalData>;
};

async function fetchBoardInit(urlAddresses: string[]): Promise<BoardInitData> {
  const res = await fetch("/api/signals");
  const json = await res.json();
  if (!json.success) throw new Error(json.error || "Failed to load signals");

  const dbTokens: SignalData[] = json.data || [];
  const columns: Record<BoardSectionType, string[]> = {
    mcap_tracker: [],
    watching: [],
    potential: [],
    rugged: [],
  };
  const tokenMcaps: Record<string, number> = {};
  const signals: Record<string, SignalData> = {};
  const seen = new Set<string>();

  dbTokens.forEach((t) => {
    const label = (t.label || "watching") as BoardSectionType;
    if (columns[label]) {
      columns[label].push(t.token_address);
      seen.add(t.token_address);
      if (t.mcap) tokenMcaps[t.token_address] = t.mcap;
      signals[t.token_address] = t;
    }
  });

  urlAddresses.forEach((addr) => {
    if (!seen.has(addr)) {
      columns.watching.push(addr);
      seen.add(addr);
    }
  });

  return { columns, tokenMcaps, signals };
}

export function useBoardInit(urlAddresses: string[]) {
  const urlKey = urlAddresses.join(",");
  return useQuery({
    queryKey: ["board-init", urlKey],
    queryFn: () => fetchBoardInit(urlAddresses),
    staleTime: 60_000,
  });
}
