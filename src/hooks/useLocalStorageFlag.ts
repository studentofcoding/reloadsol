"use client";

import { useCallback, useState } from "react";

export function useLocalStorageFlag(
  key: string,
  defaultValue = false,
): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    if (typeof window === "undefined") return defaultValue;
    return localStorage.getItem(key) === "true";
  });

  const setFlag = useCallback(
    (next: boolean) => {
      setValue(next);
      if (typeof window !== "undefined") {
        localStorage.setItem(key, next ? "true" : "false");
      }
    },
    [key],
  );

  return [value, setFlag];
}
