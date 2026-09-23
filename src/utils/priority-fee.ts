/**
 * Signals + tracker priority fees.
 *
 * Auto uses Jupiter's estimate at level "high", hard-capped at 0.003 SOL.
 * A manual Fees override is an exact tip, also capped at 0.003 SOL.
 * No DIY getRecentPrioritizationFees / Helius estimate — Jupiter and Raptor
 * apply the cap themselves.
 */

export const AUTO_PRIORITY_FEE_MAX_LAMPORTS = 3_000_000;
export const LAMPORTS_PER_SOL = 1_000_000_000;

export type JupiterPriorityLevel = "medium" | "high" | "veryHigh";

export type PriorityLevelWithMaxLamports = {
  priorityLevel: JupiterPriorityLevel;
  maxLamports: number;
  global?: boolean;
};

/**
 * Value of Jupiter Lite POST `/swap` `prioritizationFeeLamports`.
 * Prefer the object over a fixed integer. Bare `"auto"` caps at 0.005 SOL.
 */
export type JupiterPrioritizationFeeLamports =
  | number
  | { priorityLevelWithMaxLamports: PriorityLevelWithMaxLamports };

const PRIORITY_LEVELS: readonly JupiterPriorityLevel[] = [
  "medium",
  "high",
  "veryHigh",
];

export function isJupiterPriorityLevel(
  value: unknown,
): value is JupiterPriorityLevel {
  return (
    typeof value === "string" &&
    (PRIORITY_LEVELS as readonly string[]).includes(value)
  );
}

export function isAutoPriorityFee(
  fee: unknown,
): fee is { priorityLevelWithMaxLamports: PriorityLevelWithMaxLamports } {
  if (!fee || typeof fee !== "object" || !("priorityLevelWithMaxLamports" in fee)) {
    return false;
  }
  const spec = (fee as { priorityLevelWithMaxLamports?: unknown })
    .priorityLevelWithMaxLamports;
  if (!spec || typeof spec !== "object") return false;
  const level = (spec as { priorityLevel?: unknown }).priorityLevel;
  const maxLamports = (spec as { maxLamports?: unknown }).maxLamports;
  return isJupiterPriorityLevel(level) && typeof maxLamports === "number";
}

/**
 * Jupiter Lite body field for auto priority.
 * High / veryHigh are pinned to the 0.003 SOL cap: never above it, and never
 * under it (a smaller max would land slower than the locked "high" policy).
 */
export function autoPriorityFeeLamports(
  options: {
    level?: JupiterPriorityLevel;
    maxLamports?: number;
    global?: boolean;
  } = {},
): { priorityLevelWithMaxLamports: PriorityLevelWithMaxLamports } {
  const level = options.level ?? "high";
  return {
    priorityLevelWithMaxLamports: {
      priorityLevel: level,
      maxLamports: autoMaxLamportsForLevel(level, options.maxLamports),
      global: options.global ?? false,
    },
  };
}

function autoMaxLamportsForLevel(
  level: JupiterPriorityLevel,
  requested: number | undefined,
): number {
  if (level === "high" || level === "veryHigh") {
    return AUTO_PRIORITY_FEE_MAX_LAMPORTS;
  }
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return AUTO_PRIORITY_FEE_MAX_LAMPORTS;
  }
  return Math.min(Math.round(requested), AUTO_PRIORITY_FEE_MAX_LAMPORTS);
}

/** Manual Fees override: exact lamports, never above 0.003 SOL. */
export function clampManualPriorityFeeLamports(lamports: number): number {
  if (!Number.isFinite(lamports) || lamports <= 0) return 0;
  return Math.min(Math.round(lamports), AUTO_PRIORITY_FEE_MAX_LAMPORTS);
}

/**
 * Signals Fees field. Empty, blank, or non-positive → auto high.
 * A typed SOL amount is an exact tip capped at 0.003.
 */
export function priorityFeeFromSolInput(
  sol: number | "" | null | undefined,
): JupiterPrioritizationFeeLamports {
  if (
    sol === "" ||
    sol == null ||
    typeof sol !== "number" ||
    !Number.isFinite(sol) ||
    sol <= 0
  ) {
    return autoPriorityFeeLamports({
      level: "high",
      maxLamports: AUTO_PRIORITY_FEE_MAX_LAMPORTS,
    });
  }
  const lamports = clampManualPriorityFeeLamports(
    Math.round(sol * LAMPORTS_PER_SOL),
  );
  return lamports > 0
    ? lamports
    : autoPriorityFeeLamports({
        level: "high",
        maxLamports: AUTO_PRIORITY_FEE_MAX_LAMPORTS,
      });
}

/** Lamports to hold back in the wallet check. Auto reserves the cap. */
export function priorityFeeReserveLamports(
  fee: JupiterPrioritizationFeeLamports | undefined,
): number {
  if (fee == null) return AUTO_PRIORITY_FEE_MAX_LAMPORTS;
  if (typeof fee === "number") return clampManualPriorityFeeLamports(fee);
  return fee.priorityLevelWithMaxLamports.maxLamports;
}

/**
 * Shared signals/tracker policy. Omitted fee → auto high.
 * A positive number is a manual tip clamped to 0.003 SOL.
 */
export function resolveTrackerPriorityFee(
  fee?: JupiterPrioritizationFeeLamports,
): JupiterPrioritizationFeeLamports {
  if (typeof fee === "number") {
    const clamped = clampManualPriorityFeeLamports(fee);
    if (clamped > 0) return clamped;
  } else if (isAutoPriorityFee(fee)) {
    return autoPriorityFeeLamports({
      level: fee.priorityLevelWithMaxLamports.priorityLevel,
      maxLamports: fee.priorityLevelWithMaxLamports.maxLamports,
      global: fee.priorityLevelWithMaxLamports.global === true,
    });
  }
  return autoPriorityFeeLamports({
    level: "high",
    maxLamports: AUTO_PRIORITY_FEE_MAX_LAMPORTS,
  });
}

/**
 * Swap V2 GET `/order` has no `priorityLevelWithMaxLamports`.
 * Auto maps to `priorityFeeLamports` + `broadcastFeeType=maxCap`.
 * A numeric override maps to `exactFee` (total tip).
 * Numeric values are not re-capped here — tracker/signals clamp first so
 * other callers that pass their own lamport tip are left alone.
 */
export function jupiterV2PriorityFeeQuery(
  fee: JupiterPrioritizationFeeLamports | undefined,
): {
  priorityFeeLamports?: number;
  broadcastFeeType?: "maxCap" | "exactFee";
} {
  if (isAutoPriorityFee(fee)) {
    const normalized = autoPriorityFeeLamports({
      level: fee.priorityLevelWithMaxLamports.priorityLevel,
      maxLamports: fee.priorityLevelWithMaxLamports.maxLamports,
      global: fee.priorityLevelWithMaxLamports.global === true,
    });
    return {
      priorityFeeLamports: normalized.priorityLevelWithMaxLamports.maxLamports,
      broadcastFeeType: "maxCap",
    };
  }
  if (typeof fee === "number" && Number.isFinite(fee) && fee > 0) {
    return {
      priorityFeeLamports: Math.round(fee),
      broadcastFeeType: "exactFee",
    };
  }
  return {};
}

/** Lite POST `/swap` field. Numbers pass through; the auto object is normalized. */
export function jupiterLitePrioritizationFee(
  fee: JupiterPrioritizationFeeLamports | undefined,
): JupiterPrioritizationFeeLamports | undefined {
  if (typeof fee === "number") {
    if (!Number.isFinite(fee) || fee <= 0) return undefined;
    return Math.round(fee);
  }
  if (isAutoPriorityFee(fee)) {
    return autoPriorityFeeLamports({
      level: fee.priorityLevelWithMaxLamports.priorityLevel,
      maxLamports: fee.priorityLevelWithMaxLamports.maxLamports,
      global: fee.priorityLevelWithMaxLamports.global === true,
    });
  }
  return undefined;
}

/** Accept a proxy body fee (number or Jupiter object) and drop anything else. */
export function coercePrioritizationFee(
  fee: unknown,
): JupiterPrioritizationFeeLamports | undefined {
  if (typeof fee === "number") return jupiterLitePrioritizationFee(fee);
  if (!isAutoPriorityFee(fee)) return undefined;
  return jupiterLitePrioritizationFee(fee);
}

export function priorityFeeCacheToken(
  fee: JupiterPrioritizationFeeLamports | undefined,
): string {
  if (fee == null) return "0";
  if (typeof fee === "number") return String(fee);
  const spec = fee.priorityLevelWithMaxLamports;
  return `lvl:${spec.priorityLevel}:${spec.maxLamports}:${spec.global === true}`;
}
