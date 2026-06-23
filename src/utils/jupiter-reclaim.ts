import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

export const JUPITER_RECLAIM_CRAFT_BASE =
  process.env.JUPITER_ULTRA_API_BASE ?? "https://ultra-api.jup.ag";
export const RECLAIM_CRAFT_PATH = "/reclaim/craft";
export const RECLAIM_MAX_MINTS = 50;
export const RECLAIM_FETCH_TIMEOUT_MS = 20_000;

export type ReclaimCraftResponse = {
  transaction?: string;
  transactions?: string[];
  swapTransaction?: string;
  [key: string]: unknown;
};

export class JupiterReclaimError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "JupiterReclaimError";
    this.statusCode = statusCode;
  }
}

function getClientBaseUrl(): string {
  if (typeof window !== "undefined") {
    return "";
  }
  return process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST || "http://localhost:3000";
}

export async function fetchJupiterReclaimCraftDirect(
  owner: string,
  mints: string[],
): Promise<ReclaimCraftResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECLAIM_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${JUPITER_RECLAIM_CRAFT_BASE}${RECLAIM_CRAFT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-client-platform": "reloadsol",
      },
      body: JSON.stringify({ owner, mints }),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as ReclaimCraftResponse & {
      error?: string;
      message?: string;
    };

    if (!response.ok) {
      throw new JupiterReclaimError(
        payload.error || payload.message || `Jupiter reclaim craft failed (${response.status})`,
        response.status,
      );
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function craftReclaimTransaction(
  owner: string,
  mints: string[],
): Promise<ReclaimCraftResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECLAIM_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${getClientBaseUrl()}/api/jupiter/reclaim/craft`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ owner, mints }),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as ReclaimCraftResponse & {
      error?: string;
    };

    if (!response.ok) {
      throw new JupiterReclaimError(
        payload.error || `Reclaim craft proxy failed (${response.status})`,
        response.status,
      );
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export function extractReclaimTransactionBase64(
  response: ReclaimCraftResponse,
): string | null {
  if (typeof response.transaction === "string" && response.transaction.length > 0) {
    return response.transaction;
  }
  if (typeof response.swapTransaction === "string" && response.swapTransaction.length > 0) {
    return response.swapTransaction;
  }
  if (Array.isArray(response.transactions) && response.transactions.length > 0) {
    const first = response.transactions[0];
    if (typeof first === "string" && first.length > 0) {
      return first;
    }
  }
  return null;
}

export async function injectInstructionsIntoVersionedTransaction(
  connection: Connection,
  transactionBase64: string,
  extraInstructions: TransactionInstruction[],
  payer: PublicKey,
): Promise<VersionedTransaction> {
  const jupiterTransaction = VersionedTransaction.deserialize(
    Buffer.from(transactionBase64, "base64"),
  );

  const altAccountResponses = await Promise.all(
    jupiterTransaction.message.addressTableLookups.map((lookup) =>
      connection.getAddressLookupTable(lookup.accountKey),
    ),
  );

  const altAccounts: AddressLookupTableAccount[] = altAccountResponses.map((item, index) => {
    if (item.value == null) {
      throw new Error(
        `Address lookup table missing for reclaim transaction (index ${index})`,
      );
    }
    return item.value;
  });

  const decompiledMessage = TransactionMessage.decompile(jupiterTransaction.message, {
    addressLookupTableAccounts: altAccounts,
  });

  decompiledMessage.instructions.push(...extraInstructions);

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  decompiledMessage.payerKey = payer;
  decompiledMessage.recentBlockhash = blockhash;

  return new VersionedTransaction(decompiledMessage.compileToV0Message(altAccounts));
}
