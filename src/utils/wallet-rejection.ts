const REJECTION_PHRASES = [
  "user rejected",
  "user denied",
  "user cancelled",
  "user canceled",
  "rejected the request",
  "rejected by user",
  "declined by user",
] as const;

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const short =
      "shortMessage" in error &&
      typeof (error as { shortMessage?: unknown }).shortMessage === "string"
        ? (error as { shortMessage: string }).shortMessage
        : "";
    return `${short} ${error.message} ${error.name}`.trim();
  }
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "");
}

function rejectionCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const rec = error as { code?: unknown; cause?: unknown; name?: unknown };
  if (typeof rec.code === "number") return rec.code;
  if (typeof rec.code === "string" && rec.code === "ACTION_REJECTED") return 4001;
  if (rec.name === "UserRejectedRequestError") return 4001;
  return rejectionCode(rec.cause);
}

/** Rabby/viem sometimes surface the unsigned calldata as the error string. */
export function looksLikeCalldataErrorDump(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  const hex = compact.startsWith("0x") ? compact.slice(2) : compact;
  return hex.length >= 64 && /^[0-9a-fA-F]+$/.test(hex);
}

/** True when the wallet user cancelled / rejected a sign prompt. */
export function isWalletUserRejection(error: unknown): boolean {
  if (rejectionCode(error) === 4001) return true;
  const text = errorText(error);
  const lower = text.toLowerCase();
  if (REJECTION_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  return looksLikeCalldataErrorDump(text);
}
