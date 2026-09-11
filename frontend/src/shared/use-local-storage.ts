import { useCallback, useState } from "react";

/**
 * Create a `useLocalStorageState` hook scoped to a storage-key prefix.
 *
 * Both modes persist display parameters this way but under different prefixes
 * ("3dbbox_", "sge_"); the prefix must stay byte-identical or every already
 * saved user setting silently resets to its fallback.
 *
 * The returned function follows the `use*` naming convention and must be
 * called unconditionally at the top level of a component.
 */
export function createLocalStorageHook(prefix: string) {
  return function useLocalStorageState<T>(
    key: string,
    fallback: T,
  ): [T, (v: T) => void] {
    const [value, setValue] = useState<T>(() => {
      try {
        const stored = localStorage.getItem(`${prefix}${key}`);
        if (stored !== null) return JSON.parse(stored) as T;
      } catch {}
      return fallback;
    });
    const set = useCallback(
      (v: T) => {
        setValue(v);
        try {
          localStorage.setItem(`${prefix}${key}`, JSON.stringify(v));
        } catch {}
      },
      [key],
    );
    return [value, set];
  };
}
