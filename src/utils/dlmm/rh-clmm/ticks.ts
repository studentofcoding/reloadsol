import { nearestUsableTick, TickMath } from './uniswap';

/** ~ticks for a given price move: 1.0001^n ≈ ratio → n = ln(ratio)/ln(1.0001) */
export function ticksForPriceRatio(ratio: number): number {
  if (ratio <= 0 || !Number.isFinite(ratio)) throw new Error('invalid price ratio');
  return Math.ceil(Math.abs(Math.log(ratio) / Math.log(1.0001)));
}

function alignDown(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

function alignUp(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}

/**
 * How far (in raw ticks) to place the near edge from market.
 * - 0 (default): as close as Uniswap allows (adjacent usable tick / on-boundary for token1)
 * - >0: max(1 tick spacing, ~edgeBufferPercent of price), aligned to spacing
 */
export function edgeBufferTicks(tickSpacing: number, edgeBufferPercent = 0): number {
  if (edgeBufferPercent <= 0) return 0;
  const pct = Math.min(Math.max(edgeBufferPercent, 0.01), 50);
  const fromPct = ticksForPriceRatio(1 - pct / 100);
  const raw = Math.max(tickSpacing, fromPct);
  return Math.ceil(raw / tickSpacing) * tickSpacing;
}

/**
 * Single-sided range so mint only needs the deposit token.
 *
 * Uniswap V3 LiquidityAmounts (on-chain):
 * - current price **below** range  (tick < tickLower)  → only **token0**
 * - current price **above** range  (tick >= tickUpper) → only **token1**
 * - in-range → both tokens (L = min → 0 if one side is 0 → mint reverts)
 *
 * So (default: near edge as tight as possible to market):
 * - deposit token0 → range **ABOVE** market (tickLower = next usable tick above current)
 * - deposit token1 → range **BELOW** market (tickUpper = current usable tick or next below)
 *
 * That matches "limit / range-order" single-sided inventory.
 * Optional edgeBufferPercent pushes the near edge further away for a cushion.
 */
export function computeSingleSidedRange(params: {
  currentTick: number;
  tickSpacing: number;
  widthPercent: number;
  /** true if depositing token0 */
  depositIsToken0: boolean;
  /** % of price for near-edge buffer (default 0 = tightest legal gap) */
  edgeBufferPercent?: number;
}): { tickLower: number; tickUpper: number; edgeBufferTicks: number; side: 'above' | 'below' } {
  const {
    currentTick,
    tickSpacing,
    widthPercent,
    depositIsToken0,
    edgeBufferPercent = 0,
  } = params;

  if (widthPercent <= 0 || widthPercent >= 100) {
    throw new Error('widthPercent must be between 0 and 100 exclusive');
  }

  const spacing = tickSpacing;
  const minTick = nearestUsableTick(TickMath.MIN_TICK, spacing);
  const maxTick = nearestUsableTick(TickMath.MAX_TICK, spacing);
  const edge = edgeBufferTicks(spacing, edgeBufferPercent);

  const widthTicks = Math.max(spacing, ticksForPriceRatio(1 - widthPercent / 100));
  const widthAligned = Math.ceil(widthTicks / spacing) * spacing;

  if (depositIsToken0) {
    // Need currentTick < tickLower → range ABOVE market (only token0)
    // Tightest: next usable tick strictly above current (+ optional edge buffer)
    let tickLower = alignUp(currentTick + Math.max(edge, 1), spacing);
    while (tickLower <= currentTick) {
      tickLower += spacing;
    }
    if (tickLower > maxTick - spacing) {
      throw new Error('Cannot place token0 range above market near max tick');
    }

    let tickUpper = alignUp(tickLower + widthAligned, spacing);
    if (tickUpper > maxTick) tickUpper = maxTick;
    if (tickLower >= tickUpper) {
      tickUpper = Math.min(maxTick, tickLower + spacing);
    }

    assertOutOfRange({
      currentTick,
      tickLower,
      tickUpper,
      depositIsToken0: true,
    });

    return { tickLower, tickUpper, edgeBufferTicks: edge, side: 'above' };
  }

  // deposit token1: need currentTick >= tickUpper → range BELOW market (only token1)
  // Tightest: highest usable tick at or below current (− optional edge buffer).
  // On-boundary tickUpper === currentTick is valid (in-range is tick < tickUpper).
  let tickUpper = alignDown(currentTick - edge, spacing);
  if (tickUpper > currentTick) {
    // only if edge were negative; keep out-of-range
    tickUpper = alignDown(currentTick, spacing);
  }
  if (tickUpper < minTick + spacing) {
    throw new Error('Cannot place token1 range below market near min tick');
  }

  let tickLower = alignDown(tickUpper - widthAligned, spacing);
  if (tickLower < minTick) tickLower = minTick;
  if (tickLower >= tickUpper) {
    tickLower = Math.max(minTick, tickUpper - spacing);
  }

  assertOutOfRange({
    currentTick,
    tickLower,
    tickUpper,
    depositIsToken0: false,
  });

  return { tickLower, tickUpper, edgeBufferTicks: edge, side: 'below' };
}

/**
 * Ensure range is fully outside market so only the deposit token is required.
 * token0 → current < tickLower (range above)
 * token1 → current >= tickUpper (range below)
 */
export function assertOutOfRange(params: {
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  depositIsToken0: boolean;
}): void {
  const { currentTick, tickLower, tickUpper, depositIsToken0 } = params;
  if (tickLower >= tickUpper) {
    throw new Error(`Invalid ticks: lower ${tickLower} >= upper ${tickUpper}`);
  }
  if (depositIsToken0) {
    if (currentTick >= tickLower) {
      throw new Error(
        `token0 single-side needs range ABOVE market (price below range). ` +
          `current=${currentTick} lower=${tickLower}. In-range would need both tokens.`,
      );
    }
  } else if (currentTick < tickUpper) {
    throw new Error(
      `token1 single-side needs range BELOW market (price above range). ` +
        `current=${currentTick} upper=${tickUpper}. In-range would need both tokens.`,
    );
  }
}

export function tickToPriceRatio(tick: number): number {
  return Math.pow(1.0001, tick);
}

export function assertInRange(params: {
  currentTick: number;
  tickLower: number;
  tickUpper: number;
}): void {
  const { currentTick, tickLower, tickUpper } = params;
  if (tickLower >= tickUpper) {
    throw new Error(`Invalid ticks: lower ${tickLower} >= upper ${tickUpper}`);
  }
  if (currentTick < tickLower || currentTick >= tickUpper) {
    throw new Error(
      `Dual-sided needs spot inside range. current=${currentTick} [${tickLower},${tickUpper})`,
    );
  }
}

/**
 * Dual-sided in-range ticks from % offsets around spot.
 * Narrow ~±10, Wide ~±30; Full uses min/max usable ticks for the fee spacing.
 */
export function computeDualSidedRange(params: {
  currentTick: number;
  tickSpacing: number;
  /** negative; e.g. -10 → ~10% below spot */
  minPct: number;
  /** positive; e.g. 10 → ~10% above spot */
  maxPct: number;
  fullRange?: boolean;
}): { tickLower: number; tickUpper: number } {
  const { currentTick, tickSpacing, fullRange } = params;
  const spacing = tickSpacing;
  const minTick = nearestUsableTick(TickMath.MIN_TICK, spacing);
  const maxTick = nearestUsableTick(TickMath.MAX_TICK, spacing);

  if (fullRange) {
    const tickLower = minTick;
    const tickUpper = maxTick;
    assertInRange({ currentTick, tickLower, tickUpper });
    return { tickLower, tickUpper };
  }

  const minPct = Math.min(params.minPct, -0.01);
  const maxPct = Math.max(params.maxPct, 0.01);
  const lowerOff = -ticksForPriceRatio(1 + Math.abs(minPct) / 100);
  const upperOff = ticksForPriceRatio(1 + maxPct / 100);

  let tickLower = alignDown(currentTick + lowerOff, spacing);
  let tickUpper = alignUp(currentTick + upperOff, spacing);
  if (tickLower >= currentTick) tickLower = alignDown(currentTick - spacing, spacing);
  if (tickUpper <= currentTick) tickUpper = alignUp(currentTick + spacing, spacing);
  tickLower = Math.max(minTick, tickLower);
  tickUpper = Math.min(maxTick, tickUpper);

  assertInRange({ currentTick, tickLower, tickUpper });
  return { tickLower, tickUpper };
}
