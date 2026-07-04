import { describe, expect, it } from "vitest";
import {
  buildCombinedInternalExport,
  buildMcapExportPayload,
  buildSocialExportPayload,
  findSectionData,
  hasCombinedExportableData,
} from "./internal-export";
import type { RawSection } from "@/strategies/token-locate";

const meta = {
  tokenAddress: "oVDNWQ6ZPQEPp9hcP6WheeacZncyy7ubHrwnKGDpump",
  exportedAt: "2026-07-04T18:30:00.000Z",
};

const mcapRow = { token_address: meta.tokenAddress, first_mcap: 50000 };
const socialEvents = [
  { id: "e1", event_type: "mention", source: "GMGN" },
];

function section(id: string, data: unknown): RawSection {
  return {
    id,
    label: id,
    source: id,
    dataTier: "internal",
    data,
  };
}

describe("findSectionData", () => {
  it("returns data for matching section id", () => {
    const sections = [
      section("mcap-tracking", mcapRow),
      section("social-events", socialEvents),
    ];
    expect(findSectionData(sections, "mcap-tracking")).toEqual(mcapRow);
    expect(findSectionData(sections, "social-events")).toEqual(socialEvents);
  });

  it("returns null for empty arrays", () => {
    expect(findSectionData([section("social-events", [])], "social-events")).toBeNull();
  });

  it("ignores unrelated section ids", () => {
    const sections = [section("social-rollup", { mention_count_30m: 3 })];
    expect(buildMcapExportPayload(meta, sections)).toBeNull();
    expect(buildSocialExportPayload(meta, sections)).toBeNull();
  });
});

describe("buildCombinedInternalExport", () => {
  it("places mcapTracker before socialEvents and includes meta", () => {
    const sections = [
      section("mcap-tracking", mcapRow),
      section("social-events", socialEvents),
    ];
    const combined = buildCombinedInternalExport(meta, sections);
    expect(combined.tokenAddress).toBe(meta.tokenAddress);
    expect(combined.exportedAt).toBe(meta.exportedAt);
    expect(combined.mcapTracker).toEqual(mcapRow);
    expect(combined.socialEvents).toEqual(socialEvents);
    expect(Object.keys(combined)).toEqual([
      "tokenAddress",
      "exportedAt",
      "mcapTracker",
      "socialEvents",
    ]);
  });

  it("sets null for missing sections", () => {
    const combined = buildCombinedInternalExport(meta, []);
    expect(combined.mcapTracker).toBeNull();
    expect(combined.socialEvents).toBeNull();
  });

  it("does not include rollup or notifications", () => {
    const sections = [
      section("mcap-notifications", [{ id: "n1" }]),
      section("social-rollup", { mention_count_30m: 5 }),
      section("mcap-tracking", mcapRow),
      section("social-events", socialEvents),
    ];
    const combined = buildCombinedInternalExport(meta, sections);
    expect(combined.mcapTracker).toEqual(mcapRow);
    expect(combined.socialEvents).toEqual(socialEvents);
  });
});

describe("hasCombinedExportableData", () => {
  it("is true when either block has data", () => {
    expect(hasCombinedExportableData([section("mcap-tracking", mcapRow)])).toBe(true);
    expect(hasCombinedExportableData([section("social-events", socialEvents)])).toBe(
      true,
    );
    expect(hasCombinedExportableData([])).toBe(false);
  });
});
