'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * A `localStorage`-backed string with a correct hydration story.
 *
 * Built on `useSyncExternalStore` — the project's idiom for client-only reads (see
 * `useIsClient`). The SERVER snapshot is the fallback and the CLIENT snapshot is the stored value,
 * so React reconciles the two instead of the render and the server disagreeing.
 *
 * This is the difference that matters: a `useState` initialiser that reads `localStorage` runs
 * during the client's HYDRATION render too, so the first client paint showed the stored value while
 * the server had shown the fallback — server HTML != client HTML, i.e. React #418. Deriving the
 * value instead of initialising state with it removes the effect that used to paper over this.
 *
 * Raw strings in, raw strings out: strings compare by value, so `useSyncExternalStore` sees a stable
 * snapshot. Callers memoise their own parse. Returning an object or `Set` from the snapshot would
 * allocate a fresh reference on every read and loop.
 */
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  // Keep tabs in sync — `storage` fires only in OTHER documents.
  window.addEventListener('storage', callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener('storage', callback);
  };
}

export function useLocalStorageValue(
  key: string,
  fallback: string,
): [string, (next: string | ((prev: string) => string)) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(key) ?? fallback,
    () => fallback,
  );

  const set = useCallback(
    (next: string | ((prev: string) => string)) => {
      const prev = localStorage.getItem(key) ?? fallback;
      const value = typeof next === 'function' ? next(prev) : next;
      if (value === prev) return;
      localStorage.setItem(key, value);
      emit();
    },
    [key, fallback],
  );

  return [raw, set];
}
