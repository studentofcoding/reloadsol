import { describe, expect, it } from "vitest";
import type { AlgoPosition } from "@/strategies/algo-positions";
import {
  canonicalizeAlgoTesterSearch,
  filterAlgoPositions,
  mapStrategiesSearchToAlgoTester,
  openPositionsEmptyCopy,
  parseAlgoTesterQuery,
  parseAlgoTesterTab,
  positionDeskHref,
  strategyIdOptionsFromRegistry,
} from "./algo-tester-query";

function pos(
  partial: Partial<AlgoPosition> & Pick<AlgoPosition, "id" | "domain">,
): AlgoPosition {
  return {
    strategyId: "att",
    strategyName: "att",
    isSimulated: true,
    status: "open",
    tokenAddress: "Mint1",
    tokenSymbol: "AAA",
    tokenName: null,
    logoUrl: null,
    entryPriceUsd: 1,
    exitPriceUsd: null,
    entryMcap: null,
    exitMcap: null,
    pnlPct: 0,
    entryAt: null,
    exitAt: null,
    ...partial,
  };
}

describe("parseAlgoTesterTab", () => {
  it("defaults missing and dashboard to open", () => {
    expect(parseAlgoTesterTab(null)).toBe("open");
    expect(parseAlgoTesterTab("dashboard")).toBe("open");
    expect(parseAlgoTesterTab("open")).toBe("open");
    expect(parseAlgoTesterTab("unknown")).toBe("open");
  });

  it("maps config / closed aliases", () => {
    expect(parseAlgoTesterTab("config")).toBe("config");
    expect(parseAlgoTesterTab("closed")).toBe("closed");
    expect(parseAlgoTesterTab("reports")).toBe("closed");
    expect(parseAlgoTesterTab("outcomes")).toBe("closed");
  });

  it("folds workers and review into parent tabs", () => {
    expect(parseAlgoTesterTab("workers")).toBe("config");
    expect(parseAlgoTesterTab("review")).toBe("closed");
    expect(parseAlgoTesterTab("history")).toBe("open");
  });
});

describe("parseAlgoTesterQuery", () => {
  it("parses /dev/algo-tester with no tab as open", () => {
    expect(parseAlgoTesterQuery(new URLSearchParams()).tab).toBe("open");
  });

  it("parses config", () => {
    expect(
      parseAlgoTesterQuery(new URLSearchParams("tab=config")).tab,
    ).toBe("config");
  });

  it("maps dashboard to open", () => {
    const q = parseAlgoTesterQuery(new URLSearchParams("tab=dashboard"));
    expect(q.tab).toBe("open");
    expect(q.view).toBe("");
  });

  it("maps history to open + view history", () => {
    const q = parseAlgoTesterQuery(new URLSearchParams("tab=history"));
    expect(q.tab).toBe("open");
    expect(q.view).toBe("history");
  });

  it("keeps closed + domain", () => {
    const q = parseAlgoTesterQuery(
      new URLSearchParams("tab=closed&domain=mcap_tracker"),
    );
    expect(q.tab).toBe("closed");
    expect(q.domain).toBe("mcap_tracker");
  });

  it("maps reports pasted on the new URL to closed", () => {
    expect(
      parseAlgoTesterQuery(new URLSearchParams("tab=reports")).tab,
    ).toBe("closed");
  });

  it("maps workers to config panel", () => {
    const q = parseAlgoTesterQuery(new URLSearchParams("tab=workers"));
    expect(q.tab).toBe("config");
    expect(q.panel).toBe("workers");
  });

  it("maps review to closed + panel review", () => {
    const q = parseAlgoTesterQuery(new URLSearchParams("tab=review"));
    expect(q.tab).toBe("closed");
    expect(q.panel).toBe("review");
  });
});

describe("canonicalizeAlgoTesterSearch", () => {
  it("rewrites history alias", () => {
    const next = canonicalizeAlgoTesterSearch(
      new URLSearchParams("tab=history"),
    );
    const parsed = new URLSearchParams(next);
    expect(parsed.get("tab")).toBe("open");
    expect(parsed.get("view")).toBe("history");
  });

  it("rewrites workers alias", () => {
    const parsed = new URLSearchParams(
      canonicalizeAlgoTesterSearch(new URLSearchParams("tab=workers")),
    );
    expect(parsed.get("tab")).toBe("config");
    expect(parsed.get("panel")).toBe("workers");
  });
});

describe("mapStrategiesSearchToAlgoTester", () => {
  it("maps bare /dev/strategies to config", () => {
    expect(mapStrategiesSearchToAlgoTester(new URLSearchParams())).toBe(
      "/dev/algo-tester?tab=config",
    );
  });

  it("maps outcomes + tokenAddress + chain", () => {
    const dest = mapStrategiesSearchToAlgoTester(
      new URLSearchParams("tab=outcomes&tokenAddress=So111&chain=sol"),
    );
    expect(dest).toContain("/dev/algo-tester?");
    const q = new URLSearchParams(dest.split("?")[1]);
    expect(q.get("tab")).toBe("closed");
    expect(q.get("tokenAddress")).toBe("So111");
    expect(q.get("chain")).toBe("sol");
  });

  it("maps workers to config panel", () => {
    const q = new URLSearchParams(
      mapStrategiesSearchToAlgoTester(
        new URLSearchParams("tab=workers"),
      ).split("?")[1],
    );
    expect(q.get("tab")).toBe("config");
    expect(q.get("panel")).toBe("workers");
  });

  it("maps review to closed panel", () => {
    const q = new URLSearchParams(
      mapStrategiesSearchToAlgoTester(
        new URLSearchParams("tab=review"),
      ).split("?")[1],
    );
    expect(q.get("tab")).toBe("closed");
    expect(q.get("panel")).toBe("review");
  });

  it("maps reports to closed and keeps domain", () => {
    const q = new URLSearchParams(
      mapStrategiesSearchToAlgoTester(
        new URLSearchParams("tab=reports&domain=signals"),
      ).split("?")[1],
    );
    expect(q.get("tab")).toBe("closed");
    expect(q.get("domain")).toBe("signals");
  });

  it("maps unknown tab to config", () => {
    const q = new URLSearchParams(
      mapStrategiesSearchToAlgoTester(
        new URLSearchParams("tab=mystery"),
      ).split("?")[1],
    );
    expect(q.get("tab")).toBe("config");
  });
});

describe("filterAlgoPositions", () => {
  const rows: AlgoPosition[] = [
    pos({ id: "t1", domain: "trending_bot", strategyId: "att", isSimulated: true }),
    pos({
      id: "m1",
      domain: "mcap_tracker",
      strategyId: "mcap_enter_first_seen",
      isSimulated: true,
    }),
    pos({
      id: "s1",
      domain: "signals",
      strategyId: "signals_default",
      isSimulated: false,
    }),
  ];

  it("hides trending when domain=mcap_tracker", () => {
    const filtered = filterAlgoPositions(rows, { domain: "mcap_tracker" });
    expect(filtered.map((p) => p.id)).toEqual(["m1"]);
  });

  it("sim filter hides live rows", () => {
    const filtered = filterAlgoPositions(rows, { simulated: "sim" });
    expect(filtered.map((p) => p.id).sort()).toEqual(["m1", "t1"]);
  });

  it("live filter hides simulated rows", () => {
    const filtered = filterAlgoPositions(rows, { simulated: "live" });
    expect(filtered.map((p) => p.id)).toEqual(["s1"]);
  });

  it("strategyId filter", () => {
    const filtered = filterAlgoPositions(rows, { strategyId: "att" });
    expect(filtered.map((p) => p.id)).toEqual(["t1"]);
  });

  it("hides other mints when tokenAddress is set", () => {
    const minted = [
      pos({ id: "a", domain: "mcap_tracker", tokenAddress: "MintA" }),
      pos({ id: "b", domain: "mcap_tracker", tokenAddress: "MintB" }),
      pos({ id: "c", domain: "signals", tokenAddress: "minta" }),
    ];
    const filtered = filterAlgoPositions(minted, { tokenAddress: "MintA" });
    expect(filtered.map((p) => p.id)).toEqual(["a"]);
  });

  it("keeps every row when tokenAddress is empty", () => {
    const filtered = filterAlgoPositions(rows, { tokenAddress: "  " });
    expect(filtered).toHaveLength(rows.length);
  });
});

describe("openPositionsEmptyCopy", () => {
  it("names the domain filter", () => {
    expect(openPositionsEmptyCopy({ domain: "mcap_tracker" })).toBe(
      "No open mcap_tracker positions",
    );
  });

  it("names the mint when domain and tokenAddress are set", () => {
    const mint = "AVXPQqxd32ABAP5F7shHKNeWBpos9miktdH3uKqgXYJZ";
    expect(
      openPositionsEmptyCopy({ domain: "mcap_tracker", tokenAddress: mint }),
    ).toBe(`No open mcap_tracker positions for ${mint}`);
  });
});

describe("positionDeskHref", () => {
  it("deep-links mcap and signals mints to Tracker", () => {
    expect(
      positionDeskHref(pos({ id: "m", domain: "mcap_tracker", tokenAddress: "MintX" })),
    ).toBe("/dev/signals?tab=tracker&search=MintX");
    expect(
      positionDeskHref(pos({ id: "s", domain: "signals", tokenAddress: "MintY" })),
    ).toBe("/dev/signals?tab=tracker&search=MintY");
  });

  it("sends dlmm / social / gmgn to domain hubs, not Tracker", () => {
    expect(positionDeskHref(pos({ id: "d", domain: "dlmm", tokenAddress: null }))).toBe(
      "/dev/dlmm",
    );
    expect(positionDeskHref(pos({ id: "so", domain: "social" }))).toBe("/dev/social");
    expect(positionDeskHref(pos({ id: "g", domain: "gmgn" }))).toBeNull();
    expect(positionDeskHref(pos({ id: "t", domain: "trending_bot" }))).toBeNull();
  });
});

describe("strategyIdOptionsFromRegistry", () => {
  const data = {
    trending_bot: { effective: { att: { id: "att" } } },
    mcap_tracker: {
      effective: { mcap_enter_first_seen: { id: "mcap_enter_first_seen" } },
    },
    dlmm: { effective: { id: "dlmm_default" } },
  };

  it("flattens with domain prefix when All", () => {
    const opts = strategyIdOptionsFromRegistry(data, "");
    expect(opts.map((o) => o.label)).toEqual([
      "trending_bot / att",
      "mcap_tracker / mcap_enter_first_seen",
      "dlmm / dlmm_default",
    ]);
  });

  it("lists only the selected domain", () => {
    const opts = strategyIdOptionsFromRegistry(data, "mcap_tracker");
    expect(opts).toEqual([
      {
        domain: "mcap_tracker",
        id: "mcap_enter_first_seen",
        label: "mcap_enter_first_seen",
      },
    ]);
  });
});
