import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  fetchJupiterLiteQuoteDirect,
  JupiterLiteError,
  type JupiterLiteQuoteResponse,
} from "@/utils/jupiter-lite-swap";
import { quoteTriArb, defaultSlippageBps } from "./quote";
import { SOL_MINT, type TriArbQuoteResult } from "./types";

const JUPITER_LITE_SWAP_BASE = "https://lite-api.jup.ag/swap/v1";

export type JupiterSwapInstructionsResponse = {
  tokenLedgerInstruction?: unknown;
  computeBudgetInstructions?: JupiterIx[];
  setupInstructions?: JupiterIx[];
  swapInstruction: JupiterIx;
  cleanupInstruction?: JupiterIx;
  addressLookupTableAddresses?: string[];
  otherInstructions?: JupiterIx[];
};

type JupiterIx = {
  programId: string;
  accounts: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: string;
};

function toTransactionInstruction(ix: JupiterIx): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

/** Jupiter Lite swap-instructions — building block for atomic compose. */
export async function fetchJupiterLiteSwapInstructions(params: {
  quoteResponse: JupiterLiteQuoteResponse;
  userPublicKey: string;
  priorityFeeLamports?: number;
}): Promise<JupiterSwapInstructionsResponse> {
  const body: Record<string, unknown> = {
    quoteResponse: params.quoteResponse,
    userPublicKey: params.userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  };
  if (params.priorityFeeLamports && params.priorityFeeLamports > 0) {
    body.prioritizationFeeLamports = params.priorityFeeLamports;
  }

  const response = await fetch(`${JUPITER_LITE_SWAP_BASE}/swap-instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new JupiterLiteError(
      `Jupiter swap-instructions failed (${response.status}): ${text.slice(0, 200)}`,
      response.status,
    );
  }
  try {
    return JSON.parse(text) as JupiterSwapInstructionsResponse;
  } catch {
    throw new JupiterLiteError(
      `Jupiter swap-instructions invalid JSON: ${text.slice(0, 200)}`,
      response.status,
    );
  }
}

function flattenLegInstructions(
  payload: JupiterSwapInstructionsResponse,
  options?: { includeComputeBudget?: boolean },
): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  if (options?.includeComputeBudget !== false) {
    for (const ix of payload.computeBudgetInstructions ?? []) {
      out.push(toTransactionInstruction(ix));
    }
  }
  for (const ix of payload.setupInstructions ?? []) {
    out.push(toTransactionInstruction(ix));
  }
  out.push(toTransactionInstruction(payload.swapInstruction));
  if (payload.cleanupInstruction) {
    out.push(toTransactionInstruction(payload.cleanupInstruction));
  }
  for (const ix of payload.otherInstructions ?? []) {
    out.push(toTransactionInstruction(ix));
  }
  return out;
}

export type ComposeTriArbAtomicParams = {
  mintA: string;
  mintB: string;
  amountLamports: string | number;
  userPublicKey: string;
  connection: Connection;
  slippageBps?: number;
  priorityFeeLamports?: number;
};

export type ComposeTriArbAtomicResult = {
  quote: TriArbQuoteResult;
  swapTransaction: string;
  /** Estimated final SOL out from quotes (not on-chain guaranteed). */
  expectedOutSolLamports: string;
};

/**
 * L1 atomic: compose three Jupiter ExactIn legs into one VersionedTransaction.
 * Mid-leg amounts are quote-based; undershoot → tx fails (desired).
 * ponytail: CU/size may exceed limits on fat meme routes — upgrade: ALT reuse / CU tune / on-chain program.
 */
export async function composeTriArbAtomicTransaction(
  params: ComposeTriArbAtomicParams,
): Promise<ComposeTriArbAtomicResult> {
  const slippageBps = params.slippageBps ?? defaultSlippageBps();
  const quote = await quoteTriArb({
    mintA: params.mintA,
    mintB: params.mintB,
    amountLamports: params.amountLamports,
    slippageBps,
  });

  const legs = [
    {
      inputMint: SOL_MINT,
      outputMint: params.mintA,
      amount: quote.legs[0]!.inAmount,
    },
    {
      inputMint: params.mintA,
      outputMint: params.mintB,
      amount: quote.legs[1]!.inAmount,
    },
    {
      inputMint: params.mintB,
      outputMint: SOL_MINT,
      amount: quote.legs[2]!.inAmount,
    },
  ];

  const allIxs: TransactionInstruction[] = [];
  const altAddresses = new Set<string>();

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const jupQuote = await fetchJupiterLiteQuoteDirect(
      leg.inputMint,
      leg.outputMint,
      leg.amount,
      slippageBps,
    );
    const instructions = await fetchJupiterLiteSwapInstructions({
      quoteResponse: jupQuote,
      userPublicKey: params.userPublicKey,
      priorityFeeLamports: i === 0 ? params.priorityFeeLamports : undefined,
    });
    allIxs.push(
      ...flattenLegInstructions(instructions, {
        includeComputeBudget: i === 0,
      }),
    );
    for (const addr of instructions.addressLookupTableAddresses ?? []) {
      altAddresses.add(addr);
    }
  }

  const lookupTables: AddressLookupTableAccount[] = [];
  for (const addr of Array.from(altAddresses)) {
    const res = await params.connection.getAddressLookupTable(new PublicKey(addr));
    if (res.value) lookupTables.push(res.value);
  }

  const { blockhash } = await params.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: new PublicKey(params.userPublicKey),
    recentBlockhash: blockhash,
    instructions: allIxs,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(message);
  const swapTransaction = Buffer.from(tx.serialize()).toString("base64");

  return {
    quote,
    swapTransaction,
    expectedOutSolLamports: quote.outSolLamports,
  };
}
