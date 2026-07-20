import type { SolArbPair } from "./types";

/** Parse `SOL_ARB_PAIRS` JSON env into curated arb pairs. */
export function loadSolArbPairs(): SolArbPair[] {
  const raw = process.env.SOL_ARB_PAIRS?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const pairs: SolArbPair[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const mintA = typeof row.mintA === "string" ? row.mintA.trim() : "";
      const mintB = typeof row.mintB === "string" ? row.mintB.trim() : "";
      if (!mintA || !mintB || mintA === mintB) continue;
      pairs.push({
        mintA,
        mintB,
        label: typeof row.label === "string" ? row.label : undefined,
      });
    }
    return pairs;
  } catch {
    console.error("SOL_ARB_PAIRS is not valid JSON");
    return [];
  }
}

export function getSolArbScanSecret(): string {
  return (
    process.env.SOL_ARB_SCAN_SECRET?.trim() ||
    process.env.TRENDING_TRACKER_SECRET?.trim() ||
    ""
  );
}

export function isSolArbScanAuthorized(key: string | null): boolean {
  const secret = getSolArbScanSecret();
  if (!secret) return false;
  return key === secret;
}
