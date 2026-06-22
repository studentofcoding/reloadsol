"use client";

import { useSyncExternalStore } from "react";

function subscribe() {
  return () => {};
}

export function useIsClient(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
