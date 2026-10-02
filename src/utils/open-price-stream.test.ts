import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOpenPriceStream,
  subscribeOpenPrices,
} from './open-price-stream';

/**
 * The risk in this module is not parsing — it is the UNION. Two consumers with different mint sets
 * (the watchlist bar's real/priced/held set, PnLTracker's superset) must end up on ONE connection
 * covering both, and neither may drop the other's mints when it unmounts. These pin that.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

function mintsIn(url: string): string[] {
  const raw = new URL(url, 'http://x').searchParams.get('mints') ?? '';
  return raw ? raw.split(',') : [];
}

describe('open-price-stream', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    // The module checks `typeof window === 'undefined'` at call time, so a plain object is enough.
    (globalThis as unknown as { window: unknown }).window = {};
    (globalThis as unknown as { EventSource: unknown }).EventSource =
      FakeEventSource;
    __resetOpenPriceStream();
  });

  it('opens ONE connection covering the union of both consumers', () => {
    const offA = subscribeOpenPrices(['AAA', 'BBB'], () => {});
    expect(FakeEventSource.instances).toHaveLength(1);

    const offB = subscribeOpenPrices(['CCC', 'DDD'], () => {});
    // B joining re-opens the single connection wider rather than adding a second socket.
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].closed).toBe(false);
    expect(mintsIn(FakeEventSource.instances[1].url)).toEqual([
      'AAA',
      'BBB',
      'CCC',
      'DDD',
    ]);

    offA();
    offB();
  });

  it("keeps a shared mint alive until the last subscriber goes", () => {
    const offA = subscribeOpenPrices(['SHARED', 'ONLY-A'], () => {});
    const offB = subscribeOpenPrices(['SHARED', 'ONLY-B'], () => {});

    offA();
    // SHARED is still needed by B, ONLY-A is not.
    const url = FakeEventSource.instances.at(-1)!.url;
    expect(mintsIn(url)).toContain('SHARED');
    expect(mintsIn(url)).not.toContain('ONLY-A');

    offB();
    // Last subscriber gone — the connection is dropped, not left open.
    expect(FakeEventSource.instances.at(-1)!.closed).toBe(true);
  });

  it('delivers prices to every listener and ignores unusable events', () => {
    const seenA = vi.fn();
    const seenB = vi.fn();
    const offA = subscribeOpenPrices(['AAA'], seenA);
    const offB = subscribeOpenPrices(['BBB'], seenB);

    const es = FakeEventSource.instances.at(-1)!;
    es.onmessage?.({ data: JSON.stringify({ mint: 'AAA', price: 1.5 }) });
    expect(seenA).toHaveBeenCalledWith('AAA', 1.5);
    expect(seenB).toHaveBeenCalledWith('AAA', 1.5);

    // Non-positive and malformed payloads must not reach listeners — a 0 would render as a real
    // price and the poll's one-poll grace exists precisely to avoid that.
    es.onmessage?.({ data: JSON.stringify({ mint: 'AAA', price: 0 }) });
    es.onmessage?.({ data: JSON.stringify({ mint: 'AAA', price: -1 }) });
    es.onmessage?.({ data: 'not json' });
    expect(seenA).toHaveBeenCalledTimes(1);

    offA();
    offB();
  });

  it('re-opens on the next subscriber after the stream errors', () => {
    const off = subscribeOpenPrices(['AAA'], () => {});
    FakeEventSource.instances.at(-1)!.onerror?.();
    expect(FakeEventSource.instances.at(-1)!.closed).toBe(true);

    // A later change re-establishes it rather than staying permanently dead.
    const off2 = subscribeOpenPrices(['BBB'], () => {});
    expect(FakeEventSource.instances.at(-1)!.closed).toBe(false);
    off();
    off2();
  });
});
