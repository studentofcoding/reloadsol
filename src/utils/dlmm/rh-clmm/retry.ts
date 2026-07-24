/** Small retry helpers for flaky RPC / path fallbacks */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run `fn` up to `times` times. On failure, wait `backoffMs * attempt` then retry.
 * Does not retry if `shouldRetry` returns false.
 */
export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    times?: number;
    backoffMs?: number;
    label?: string;
    shouldRetry?: (err: unknown, attempt: number) => boolean;
  } = {},
): Promise<T> {
  const times = opts.times ?? 3;
  const backoffMs = opts.backoffMs ?? 800;
  const label = opts.label ?? 'op';
  let last: unknown;
  for (let i = 1; i <= times; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      const retry =
        opts.shouldRetry?.(e, i) ??
        // default: retry transient / path failures, not "no balance" / "not found"
        !/no balance|not found|already empty|tokenIn === tokenOut|invalid address/i.test(
          msg,
        );
      console.warn(`[retry ${label}] attempt ${i}/${times} failed: ${msg.slice(0, 160)}`);
      if (!retry || i === times) break;
      await sleep(backoffMs * i);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
