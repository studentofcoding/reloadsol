import { shyftPost, ShyftAPIError } from "@/utils/shyft-api";

export type ShyftSendTxnResult = {
  signature: string;
};

export type ShyftSendTxnResponse = {
  success: boolean;
  signature?: string;
};

/** Server-side: POST /sol/v1/transaction/send_txn */
export async function sendShyftTransactionDirect(
  encodedTransaction: string,
  network: string = "mainnet-beta",
): Promise<ShyftSendTxnResponse> {
  const { result } = await shyftPost<ShyftSendTxnResult>(
    "/sol/v1/transaction/send_txn",
    {
      network,
      encoded_transaction: encodedTransaction,
    },
  );

  if (!result.signature) {
    throw new ShyftAPIError("Shyft send_txn returned no signature");
  }

  return { success: true, signature: result.signature };
}

/** Client-side: proxied send_txn */
export async function sendShyftTransaction(
  encodedTransaction: string,
  network: string = "mainnet-beta",
): Promise<ShyftSendTxnResponse> {
  const response = await fetch("/api/shyft/transaction/send_txn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      encoded_transaction: encodedTransaction,
      network,
    }),
  });

  const bodyText = await response.text().catch(() => "");
  if (!response.ok) {
    throw new ShyftAPIError(
      `Shyft send proxy failed (${response.status}): ${bodyText.slice(0, 200)}`,
      response.status,
    );
  }

  let data: { success?: boolean; signature?: string; error?: string };
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    throw new ShyftAPIError(
      `Shyft send proxy returned invalid JSON: ${bodyText.slice(0, 200)}`,
      response.status,
    );
  }

  if (!data.success || !data.signature) {
    throw new ShyftAPIError(data.error ?? "Shyft send_txn failed");
  }

  return { success: true, signature: data.signature };
}

export type ShyftManySendResultItem = {
  id: number;
  signature?: string;
  status?: string | null;
  error?: unknown;
};

export type ShyftManySendResponse = {
  success: boolean;
  results: ShyftManySendResultItem[];
};

/** Server-side: POST /sol/v1/transaction/send_many_txns */
export async function sendShyftManyTransactionsDirect(
  encodedTransactions: string[],
  network: string = "mainnet-beta",
): Promise<ShyftManySendResponse> {
  if (encodedTransactions.length === 0) {
    throw new ShyftAPIError("send_many_txns requires at least one transaction");
  }

  const { result } = await shyftPost<ShyftManySendResultItem[]>(
    "/sol/v1/transaction/send_many_txns",
    {
      network,
      encoded_transactions: encodedTransactions,
    },
  );

  return { success: true, results: result ?? [] };
}

/** Client-side: proxied send_many_txns */
export async function sendShyftManyTransactions(
  encodedTransactions: string[],
  network: string = "mainnet-beta",
): Promise<ShyftManySendResponse> {
  const response = await fetch("/api/shyft/transaction/send_many_txns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      encoded_transactions: encodedTransactions,
      network,
    }),
  });

  const bodyText = await response.text().catch(() => "");
  if (!response.ok) {
    throw new ShyftAPIError(
      `Shyft send_many proxy failed (${response.status}): ${bodyText.slice(0, 200)}`,
      response.status,
    );
  }

  let data: {
    success?: boolean;
    results?: ShyftManySendResultItem[];
    error?: string;
  };
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    throw new ShyftAPIError(
      `Shyft send_many proxy returned invalid JSON: ${bodyText.slice(0, 200)}`,
      response.status,
    );
  }

  if (!data.success || !Array.isArray(data.results)) {
    throw new ShyftAPIError(data.error ?? "Shyft send_many_txns failed");
  }

  return { success: true, results: data.results };
}
