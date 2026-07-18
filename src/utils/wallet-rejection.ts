const REJECTION_PHRASES = [
  "user rejected",
  "user denied",
  "user cancelled",
  "user canceled",
  "rejected by user",
  "declined by user",
] as const;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "");
}

/** True when the wallet user cancelled / rejected a sign prompt. */
export function isWalletUserRejection(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return REJECTION_PHRASES.some((phrase) => text.includes(phrase));
}
