import { useCallback, useEffect, useState } from "react";

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
  ): [T, (v: T | ((prev: T) => T)) => void] {
    const [value, setValue] = useState<T>(() => {
      try {
        const stored = localStorage.getItem(`${prefix}${key}`);
        if (stored !== null) return JSON.parse(stored) as T;
      } catch {}
      return fallback;
    });
    const set = useCallback(
      (v: T | ((prev: T) => T)) => {
        // The updater must stay pure: React may invoke it on renders that
        // are later discarded (StrictMode double-invocation, concurrent
        // transitions), so persisting from inside it could let storage
        // run ahead of the committed state. Persistence happens in the
        // effect below, after the value commits.
        setValue((prev) =>
          typeof v === "function" ? (v as (prev: T) => T)(prev) : v,
        );
      },
      [key],
    );
    useEffect(() => {
      try {
        localStorage.setItem(`${prefix}${key}`, JSON.stringify(value));
      } catch {}
    }, [prefix, key, value]);
    return [value, set];
  };
}
