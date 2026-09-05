const KEY = 'reloadsol.trade-auto-confirm'

/** Default on: user confirms in the wallet, not a second in-app click. */
export function readTradeAutoConfirm(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export function writeTradeAutoConfirm(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}
