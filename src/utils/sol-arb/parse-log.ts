/**
 * Best-effort arb log parser: our API JSON or freeform trade tables.
 * Raw string is always returned unchanged.
 */

export type ArbLogRow = {
  time?: string;
  wallet?: string;
  action: string;
  amount?: string;
  usd?: string;
  detail?: string;
};

export type ArbLogTotals = {
  solSpent?: number;
  solReceived?: number;
  netSol?: number;
  roiPct?: number;
};

export type ArbLogParseResult = {
  raw: string;
  kind: "json" | "freeform" | "empty";
  rows: ArbLogRow[];
  totals?: ArbLogTotals;
  parseNotes: string[];
};

const SOL_BUY_RE =
  /\b(?:buy|bought|buys)\b.*?([\d.,]+)\s*(?:SOL|sol)\b/i;
const SOL_SELL_RE =
  /\b(?:sell|sold|sells)\b.*?([\d.,]+)\s*(?:SOL|sol)\b|\b([\d.,]+)\s*(?:SOL|sol)\b.*?\b(?:received|for)\b/i;
const SPENT_SOL_RE =
  /(?:spent|pay|paid|with)\s+([\d.,]+)\s*(?:SOL|sol)\b/i;
const RECV_SOL_RE =
  /(?:for|→|->|received)\s+([\d.,]+)\s*(?:SOL|sol)\b/i;
const TIME_RE = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/;
const WALLET_RE = /\b(W\d+|wallet\s*\d+)\b/i;

function parseNum(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseOurApiJson(raw: string): ArbLogParseResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const notes: string[] = ["Detected JSON"];
  const rows: ArbLogRow[] = [];
  let totals: ArbLogTotals | undefined;

  const root = isRecord(parsed) ? parsed : null;
  if (!root) {
    return {
      raw,
      kind: "json",
      rows: [],
      parseNotes: ["JSON parsed but not an object"],
    };
  }

  const quote = isRecord(root.quote)
    ? root.quote
    : isRecord(root) && Array.isArray(root.legs)
      ? root
      : null;

  if (quote && Array.isArray(quote.legs)) {
    notes.push("Mapped quote.legs / legs");
    for (const leg of quote.legs) {
      if (!isRecord(leg)) continue;
      rows.push({
        action: String(leg.leg ?? "leg"),
        amount: `in ${String(leg.inAmount ?? "?")} → out ${String(leg.outAmount ?? "?")}`,
        detail: typeof leg.provider === "string" ? leg.provider : undefined,
      });
    }
    const inSol = parseNum(String(quote.inSolLamports ?? ""));
    const outSol = parseNum(String(quote.outSolLamports ?? ""));
    const net = parseNum(String(quote.netSolLamports ?? ""));
    if (inSol != null || outSol != null || net != null) {
      const spent = inSol != null ? inSol / 1e9 : undefined;
      const received = outSol != null ? outSol / 1e9 : undefined;
      const netSol =
        net != null
          ? net / 1e9
          : spent != null && received != null
            ? received - spent
            : undefined;
      const roi =
        typeof quote.roiPct === "number"
          ? quote.roiPct
          : spent && spent > 0 && netSol != null
            ? (netSol / spent) * 100
            : undefined;
      totals = { solSpent: spent, solReceived: received, netSol, roiPct: roi };
    }
  }

  if (Array.isArray(root.legs) && !quote) {
    notes.push("Mapped execute legs");
    for (const leg of root.legs) {
      if (!isRecord(leg)) continue;
      rows.push({
        action: String(leg.leg ?? "leg"),
        amount: leg.outAmount
          ? `in ${String(leg.inAmount ?? "?")} → out ${String(leg.outAmount)}`
          : `in ${String(leg.inAmount ?? "?")}`,
        detail:
          leg.success === false
            ? `FAIL ${String(leg.error ?? "")}`
            : typeof leg.signature === "string"
              ? leg.signature
              : undefined,
      });
    }
  }

  if (Array.isArray(root.hits)) {
    notes.push("Mapped scan hits");
    for (const hit of root.hits) {
      if (!isRecord(hit)) continue;
      const q = isRecord(hit.quote) ? hit.quote : null;
      rows.push({
        action: typeof hit.label === "string" ? hit.label : "scan hit",
        amount: q
          ? `net ${String(q.netSolLamports ?? "?")} lamports (${String(q.roiPct ?? "?")}%)`
          : undefined,
      });
    }
  }

  if (rows.length === 0) {
    notes.push("JSON recognized but no known arb shape — show raw only");
  }

  return { raw, kind: "json", rows, totals, parseNotes: notes };
}

function classifyFreeformAction(line: string): string {
  const lower = line.toLowerCase();
  if (/\btransfer|sends?\s+back|send\b/.test(lower)) return "transfer";
  if (/\bswap|scale\b/.test(lower)) return "swap";
  if (/\bbuy|bought|buys\b/.test(lower)) return "buy";
  if (/\bsell|sold|sells\b/.test(lower)) return "sell";
  return "other";
}

function parseFreeform(raw: string): ArbLogParseResult {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[-|=]+$/.test(l));

  const rows: ArbLogRow[] = [];
  const notes: string[] = ["Freeform / table heuristic"];
  let solSpent = 0;
  let solReceived = 0;
  let spentHits = 0;
  let recvHits = 0;

  for (const line of lines) {
    if (/^time\b/i.test(line) && /wallet/i.test(line)) {
      notes.push("Skipped header row");
      continue;
    }
    if (/^(total|grand|net pnl|roi)\b/i.test(line)) {
      const spentM = line.match(/spent[:\s]+([\d.,]+)/i);
      const recvM = line.match(/received[:\s]+([\d.,]+)/i);
      const netM = line.match(/(?:net|pnl)[:\s+]*([+-]?[\d.,]+)/i);
      const roiM = line.match(/([\d.,]+)\s*%/);
      if (spentM || recvM || netM || roiM) {
        notes.push("Parsed summary line");
        return {
          raw,
          kind: "freeform",
          rows,
          totals: {
            solSpent: parseNum(spentM?.[1] ?? undefined) ?? undefined,
            solReceived: parseNum(recvM?.[1] ?? undefined) ?? undefined,
            netSol: parseNum(netM?.[1] ?? undefined) ?? undefined,
            roiPct: parseNum(roiM?.[1] ?? undefined) ?? undefined,
          },
          parseNotes: notes,
        };
      }
    }

    const time = line.match(TIME_RE)?.[1];
    const wallet = line.match(WALLET_RE)?.[1];
    const action = classifyFreeformAction(line);

    let solDelta: number | null = null;
    const buySol = line.match(SOL_BUY_RE)?.[1] ?? line.match(SPENT_SOL_RE)?.[1];
    const sellSol =
      line.match(SOL_SELL_RE)?.[1] ??
      line.match(SOL_SELL_RE)?.[2] ??
      line.match(RECV_SOL_RE)?.[1];

    if (action === "buy" && buySol) {
      solDelta = parseNum(buySol);
      if (solDelta != null) {
        solSpent += solDelta;
        spentHits += 1;
      }
    } else if (action === "sell" && sellSol) {
      solDelta = parseNum(sellSol);
      if (solDelta != null) {
        solReceived += solDelta;
        recvHits += 1;
      }
    } else if (sellSol && /\bSOL\b/i.test(line) && action === "swap") {
      // SCALE hops often labeled swap without clear SOL side — skip totals
    }

    const parts = line.split(/\t+|\s{2,}/).map((p) => p.trim()).filter(Boolean);
    rows.push({
      time,
      wallet,
      action,
      amount: parts.length >= 4 ? parts[3] : solDelta != null ? `${solDelta} SOL` : undefined,
      usd: parts.length >= 5 ? parts[4] : undefined,
      detail: line,
    });
  }

  let totals: ArbLogTotals | undefined;
  if (spentHits > 0 || recvHits > 0) {
    const netSol = solReceived - solSpent;
    totals = {
      solSpent: spentHits > 0 ? solSpent : undefined,
      solReceived: recvHits > 0 ? solReceived : undefined,
      netSol,
      roiPct: solSpent > 0 ? (netSol / solSpent) * 100 : undefined,
    };
    notes.push(
      `Accumulated SOL from ${spentHits} buy(s) / ${recvHits} sell(s)`,
    );
  } else {
    notes.push("No clear SOL spend/receive amounts for totals");
  }

  return { raw, kind: "freeform", rows, totals, parseNotes: notes };
}

/** Parse pasted arb log — never mutates `raw`. */
export function parseArbLog(input: string): ArbLogParseResult {
  const raw = input;
  if (!raw.trim()) {
    return { raw, kind: "empty", rows: [], parseNotes: ["Empty paste"] };
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const jsonResult = parseOurApiJson(trimmed);
    if (jsonResult) return jsonResult;
  }

  return parseFreeform(raw);
}
