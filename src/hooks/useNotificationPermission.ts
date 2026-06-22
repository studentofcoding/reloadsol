"use client";

import { useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return () => {};
  }
  // Permission changes are rare; poll on focus as a lightweight fallback
  window.addEventListener("focus", callback);
  return () => window.removeEventListener("focus", callback);
}

function getSnapshot(): NotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "default";
  }
  return Notification.permission;
}

function getServerSnapshot(): NotificationPermission {
  return "default";
}

export function useNotificationPermission() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
