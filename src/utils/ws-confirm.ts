/**
 * Confirm signatures via Solana RPC WebSocket signatureSubscribe.
 *
 * signatureSubscribe only notifies for confirmations that happen AFTER the
 * subscription, so callers must pass `checkNow` (a one-shot batched status
 * check) to catch transactions that already landed before we subscribed.
 *
 * Returns a map with only the signatures that were resolved (null = confirmed,
 * string = on-chain error). Unresolved signatures are absent so the caller can
 * fall back to HTTP polling.
 */

type JsonRpcMessage = {
  id?: number;
  result?: unknown;
  method?: string;
  params?: {
    subscription?: number;
    result?: { value?: { err?: unknown } };
  };
};

export type WsConfirmOptions = {
  timeoutMs?: number;
  /** One-shot batched status check for sigs that confirmed before subscribing. */
  checkNow?: (signatures: string[]) => Promise<Map<string, string | null>>;
  /** Delay before running checkNow, letting subscriptions settle first. */
  snapshotDelayMs?: number;
  /** Injectable for tests. */
  webSocketFactory?: (url: string) => WebSocket;
};

const DEFAULT_WS_TIMEOUT_MS = 40_000;
const DEFAULT_SNAPSHOT_DELAY_MS = 2_000;

export async function confirmSignaturesViaWs(
  signatures: string[],
  wsUrl: string,
  options?: WsConfirmOptions,
): Promise<Map<string, string | null>> {
  const resolved = new Map<string, string | null>();
  if (signatures.length === 0) return resolved;

  const timeoutMs = options?.timeoutMs ?? DEFAULT_WS_TIMEOUT_MS;
  const snapshotDelayMs = options?.snapshotDelayMs ?? DEFAULT_SNAPSHOT_DELAY_MS;
  const makeSocket =
    options?.webSocketFactory ?? ((url: string) => new WebSocket(url));

  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = makeSocket(wsUrl);
    } catch {
      resolve(resolved);
      return;
    }

    const requestIdToSig = new Map<number, string>();
    const subscriptionToSig = new Map<number, string>();
    const pending = new Set(signatures);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(resolved);
    };

    const settle = (signature: string, error: string | null) => {
      if (!pending.has(signature)) return;
      pending.delete(signature);
      resolved.set(signature, error);
      if (pending.size === 0) finish();
    };

    timers.push(setTimeout(finish, timeoutMs));

    ws.onopen = () => {
      signatures.forEach((signature, index) => {
        const id = index + 1;
        requestIdToSig.set(id, signature);
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "signatureSubscribe",
            params: [signature, { commitment: "confirmed" }],
          }),
        );
      });

      // Snapshot for txs that confirmed before the subscriptions were live.
      if (options?.checkNow) {
        timers.push(
          setTimeout(async () => {
            try {
              const snapshot = await options.checkNow!(Array.from(pending));
              for (const [signature, error] of Array.from(snapshot.entries())) {
                settle(signature, error);
              }
            } catch {
              // Snapshot is best-effort; WS notifications still cover new confirms.
            }
          }, snapshotDelayMs),
        );
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(String(event.data)) as JsonRpcMessage;
      } catch {
        return;
      }

      // Subscription ack: map subscription id -> signature
      if (message.id != null && typeof message.result === "number") {
        const signature = requestIdToSig.get(message.id);
        if (signature) subscriptionToSig.set(message.result, signature);
        return;
      }

      // Confirmation notification (one-shot; RPC auto-unsubscribes after firing)
      if (
        message.method === "signatureNotification" &&
        message.params?.subscription != null
      ) {
        const signature = subscriptionToSig.get(message.params.subscription);
        if (!signature) return;
        const err = message.params.result?.value?.err;
        settle(
          signature,
          err ? `Transaction failed on-chain: ${JSON.stringify(err)}` : null,
        );
      }
    };

    ws.onerror = () => finish();
    ws.onclose = () => finish();
  });
}
