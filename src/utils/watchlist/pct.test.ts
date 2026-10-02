import { describe, expect, it } from 'vitest';
import { pctFromBaseline } from './pct';

/**
 * `pctFromBaseline` is the ONE percentage both surfaces render — the watchlist bar
 * (`useOpenPositions`) and PnLTracker's open positions (`applyOpenPrices`). It replaced an inline
 * `((current - initial) / initial) * 100` in PnLTracker (2026-10-02), so these cases pin the
 * semantics that substitution relied on: the null branch is reachable ONLY for a non-positive or
 * missing input, which is why the guards at the PnLTracker call site make it total there.
 */
describe('pctFromBaseline', () => {
  it('returns the signed percentage change from the baseline', () => {
    expect(pctFromBaseline(100, 150)).toBe(50);
    expect(pctFromBaseline(100, 50)).toBe(-50);
    expect(pctFromBaseline(100, 100)).toBe(0);
  });

  it('agrees with the inline formula it replaced', () => {
    const inline = (initial: number, current: number) =>
      ((current - initial) / initial) * 100;
    for (const [initial, current] of [
      [1, 2],
      [0.0001, 0.0003],
      [273.15, 91.7],
      [1000, 999.999],
    ]) {
      expect(pctFromBaseline(initial, current)).toBe(inline(initial, current));
    }
  });

  it('returns null rather than a fabricated number when either side is unusable', () => {
    // A missing or non-positive baseline is the only thing that yields null here. Callers must treat
    // null as "unknown", never as zero.
    expect(pctFromBaseline(null, 150)).toBeNull();
    expect(pctFromBaseline(undefined, 150)).toBeNull();
    expect(pctFromBaseline(0, 150)).toBeNull();
    expect(pctFromBaseline(-5, 150)).toBeNull();
    expect(pctFromBaseline(100, null)).toBeNull();
    expect(pctFromBaseline(100, undefined)).toBeNull();
    expect(pctFromBaseline(100, 0)).toBeNull();
    expect(pctFromBaseline(100, -5)).toBeNull();
  });
});
