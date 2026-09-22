import type { StrategyDomain } from "@/strategies/types";

export const ALGO_TESTER_TABS = ["config", "open", "closed"] as const;
export type AlgoTesterTab = (typeof ALGO_TESTER_TABS)[number];

export const ALGO_TESTER_OPEN_HREF = "/dev/algo-tester?tab=open";
export const ALGO_TESTER_CLOSED_HREF = "/dev/algo-tester?tab=closed";
export const ALGO_TESTER_CONFIG_HREF = "/dev/algo-tester?tab=config";

export type AlgoTesterSimulated = "all" | "sim" | "live";
export type AlgoTesterPanel = "workers" | "review" | "";
export type AlgoTesterView = "history" | "";

export type AlgoTesterQuery = {
  tab: AlgoTesterTab;
  domain: StrategyDomain | "";
  strategyId: string;
  simulated: AlgoTesterSimulated;
  tokenAddress: string;
  panel: AlgoTesterPanel;
  view: AlgoTesterView;
};

export const STRATEGY_DOMAINS: readonly StrategyDomain[] = [
  "trending_bot",
  "signals",
  "mcap_tracker",
  "gmgn",
  "social",
  "dlmm",
];

export const STRATEGY_DOMAIN_LABELS: Record<StrategyDomain, string> = {
  trending_bot: "Trending bot",
  signals: "Signals",
  mcap_tracker: "MCap tracker",
  gmgn: "GMGN",
  social: "Social",
  dlmm: "DLMM",
};

export const STRATEGY_DOMAIN_OPTIONS: {
  value: StrategyDomain | "";
  label: string;
}[] = [
  { value: "", label: "All" },
  ...STRATEGY_DOMAINS.map((value) => ({
    value,
    label: STRATEGY_DOMAIN_LABELS[value],
  })),
];

export function isStrategyDomain(value: string | null): value is StrategyDomain {
  return STRATEGY_DOMAINS.some((d) => d === value);
}

export function parseAlgoTesterTab(raw: string | null): AlgoTesterTab {
  if (raw === "config") return "config";
  if (raw === "closed" || raw === "reports" || raw === "outcomes") return "closed";
  if (raw === "review") return "closed";
  if (raw === "workers") return "config";
  return "open";
}

export function parseAlgoTesterPanel(
  rawTab: string | null,
  rawPanel: string | null,
): AlgoTesterPanel {
  if (rawPanel === "workers" || rawTab === "workers") return "workers";
  if (rawPanel === "review" || rawTab === "review") return "review";
  return "";
}

export function parseAlgoTesterView(
  rawTab: string | null,
  rawView: string | null,
): AlgoTesterView {
  if (rawView === "history" || rawTab === "history") return "history";
  return "";
}

export function parseAlgoTesterDomain(raw: string | null): StrategyDomain | "" {
  return isStrategyDomain(raw) ? raw : "";
}

export function parseAlgoTesterSimulated(
  raw: string | null,
): AlgoTesterSimulated {
  if (raw === "sim" || raw === "live") return raw;
  if (raw === "true") return "sim";
  if (raw === "false") return "live";
  return "all";
}

export function simulatedToReportParam(simulated: AlgoTesterSimulated): string {
  if (simulated === "sim") return "true";
  if (simulated === "live") return "false";
  return "";
}

export function parseAlgoTesterQuery(
  search: URLSearchParams,
): AlgoTesterQuery {
  const rawTab = search.get("tab");
  const tab = parseAlgoTesterTab(rawTab);
  const rawPanel = parseAlgoTesterPanel(rawTab, search.get("panel"));
  const view = parseAlgoTesterView(rawTab, search.get("view"));
  const panel: AlgoTesterPanel =
    (tab === "config" && rawPanel === "workers") ||
    (tab === "closed" && rawPanel === "review")
      ? rawPanel
      : "";
  return {
    tab,
    domain: parseAlgoTesterDomain(search.get("domain")),
    strategyId: search.get("strategyId") ?? "",
    simulated: parseAlgoTesterSimulated(
      search.get("simulated") ?? search.get("is_simulated"),
    ),
    tokenAddress: search.get("tokenAddress") ?? "",
    panel,
    view: tab === "open" ? view : "",
  };
}

/** Canonical query string (tab aliases resolved). Does not reorder unrelated params. */
export function canonicalizeAlgoTesterSearch(
  search: URLSearchParams,
): string {
  const parsed = parseAlgoTesterQuery(search);
  const next = new URLSearchParams(search);
  next.set("tab", parsed.tab);
  if (parsed.panel) next.set("panel", parsed.panel);
  else next.delete("panel");
  if (parsed.view) next.set("view", parsed.view);
  else next.delete("view");
  if (parsed.domain) next.set("domain", parsed.domain);
  else next.delete("domain");
  if (parsed.strategyId) next.set("strategyId", parsed.strategyId);
  else next.delete("strategyId");
  if (parsed.simulated !== "all") next.set("simulated", parsed.simulated);
  else {
    next.delete("simulated");
    next.delete("is_simulated");
  }
  if (parsed.tokenAddress) next.set("tokenAddress", parsed.tokenAddress);
  else next.delete("tokenAddress");
  return next.toString();
}

/**
 * Map `/dev/strategies` search params onto `/dev/algo-tester`.
 * Unknown / missing tab → config (Strategy Admin default).
 */
export function mapStrategiesSearchToAlgoTester(
  search: URLSearchParams,
): string {
  const tab = search.get("tab");
  const next = new URLSearchParams(search);
  next.delete("tab");
  if (tab === "workers") {
    next.set("tab", "config");
    next.set("panel", "workers");
  } else if (tab === "review") {
    next.set("tab", "closed");
    next.set("panel", "review");
  } else if (tab === "reports" || tab === "outcomes") {
    next.set("tab", "closed");
  } else {
    next.set("tab", "config");
  }
  return `/dev/algo-tester?${next.toString()}`;
}

export type AlgoPositionFilterRow = {
  domain: string;
  strategyId: string;
  isSimulated: boolean;
  tokenAddress?: string | null;
};

export function filterAlgoPositions<T extends AlgoPositionFilterRow>(
  rows: T[],
  f: {
    domain?: string;
    strategyId?: string;
    simulated?: AlgoTesterSimulated;
    tokenAddress?: string;
  },
): T[] {
  const mint = f.tokenAddress?.trim() ?? "";
  return rows.filter((p) => {
    if (f.domain && p.domain !== f.domain) return false;
    if (f.strategyId && p.strategyId !== f.strategyId) return false;
    if (f.simulated === "sim" && !p.isSimulated) return false;
    if (f.simulated === "live" && p.isSimulated) return false;
    if (mint && p.tokenAddress !== mint) return false;
    return true;
  });
}

export function openPositionsEmptyCopy(f: {
  domain?: string;
  strategyId?: string;
  simulated?: AlgoTesterSimulated;
  tokenAddress?: string;
}): string {
  const mint = f.tokenAddress?.trim() ?? "";
  if (f.domain && mint && !f.strategyId && (!f.simulated || f.simulated === "all")) {
    return `No open ${f.domain} positions for ${mint}`;
  }
  if (f.domain && !f.strategyId && (!f.simulated || f.simulated === "all")) {
    return `No open ${f.domain} positions`;
  }
  const bits = [
    f.simulated === "sim" ? "sim" : f.simulated === "live" ? "live" : null,
    f.domain || null,
    f.strategyId || null,
  ].filter(Boolean);
  if (bits.length === 0) {
    return mint ? `No open algo positions for ${mint}` : "No open algo positions";
  }
  return mint
    ? `No open ${bits.join(" ")} positions for ${mint}`
    : `No open ${bits.join(" ")} positions`;
}

export type StrategyIdOption = {
  domain: StrategyDomain;
  id: string;
  label: string;
};

type RegistrySlice = {
  effective?: Record<string, { id?: string }> | { id?: string };
  active?: string[];
};

export function strategyIdOptionsFromRegistry(
  data: {
    trending_bot?: RegistrySlice;
    signals?: RegistrySlice;
    mcap_tracker?: RegistrySlice;
    gmgn?: RegistrySlice;
    social?: RegistrySlice;
    dlmm?: { effective?: { id?: string } };
  } | null | undefined,
  domain: StrategyDomain | "",
): StrategyIdOption[] {
  if (!data) return [];
  const out: StrategyIdOption[] = [];
  const pushDomain = (d: StrategyDomain, effective?: Record<string, { id?: string }>) => {
    if (!effective) return;
    for (const [id, row] of Object.entries(effective)) {
      const sid = row?.id || id;
      out.push({
        domain: d,
        id: sid,
        label: domain ? sid : `${d} / ${sid}`,
      });
    }
  };
  if (!domain || domain === "trending_bot") {
    pushDomain("trending_bot", data.trending_bot?.effective as Record<string, { id?: string }>);
  }
  if (!domain || domain === "signals") {
    pushDomain("signals", data.signals?.effective as Record<string, { id?: string }>);
  }
  if (!domain || domain === "mcap_tracker") {
    pushDomain("mcap_tracker", data.mcap_tracker?.effective as Record<string, { id?: string }>);
  }
  if (!domain || domain === "gmgn") {
    pushDomain("gmgn", data.gmgn?.effective as Record<string, { id?: string }>);
  }
  if (!domain || domain === "social") {
    pushDomain("social", data.social?.effective as Record<string, { id?: string }>);
  }
  if (!domain || domain === "dlmm") {
    const id = data.dlmm?.effective?.id || "dlmm_default";
    if (data.dlmm?.effective) {
      out.push({
        domain: "dlmm",
        id,
        label: domain ? id : `dlmm / ${id}`,
      });
    }
  }
  return out;
}

export function positionDeskHref(position: {
  domain: string;
  tokenAddress?: string | null;
}): string | null {
  const mint = position.tokenAddress;
  if (
    (position.domain === "mcap_tracker" || position.domain === "signals") &&
    mint
  ) {
    return `/dev/signals?tab=tracker&search=${encodeURIComponent(mint)}`;
  }
  if (position.domain === "dlmm") return "/dev/dlmm";
  if (position.domain === "social") return "/dev/social";
  return null;
}
