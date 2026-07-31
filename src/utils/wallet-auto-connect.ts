/**
 * Only auto-reconnect when the user previously selected a wallet.
 * Blind autoConnect leaves `connecting=true` and disables Connect.
 */
export function shouldAutoConnectWallet(opts: {
  hasDisconnected: boolean;
  priorWalletName: string | null | undefined;
}): boolean {
  if (opts.hasDisconnected) return false;
  const name = opts.priorWalletName?.trim();
  return Boolean(name);
}
