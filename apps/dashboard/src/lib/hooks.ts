"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { demoStore } from "./demo/store";

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch on mount and whenever `key` changes. `key === null` skips the request.
 * Keeps the previous data while reloading so maps do not flash.
 */
export function useApiData<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>, refreshMs?: number): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(key !== null);
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (key === null) return;
    const ctrl = new AbortController();
    let cancelled = false;
    const run = () => {
      setLoading(true);
      fetcherRef
        .current(ctrl.signal)
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setError(undefined);
        })
        .catch((e: unknown) => {
          if (cancelled || (e instanceof DOMException && e.name === "AbortError")) return;
          setError(e instanceof Error ? e : new Error(String(e)));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    run();
    const timer = refreshMs ? setInterval(run, refreshMs) : undefined;
    return () => {
      cancelled = true;
      ctrl.abort();
      if (timer) clearInterval(timer);
    };
  }, [key, nonce, refreshMs]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

let demoVersion = 0;
demoStore.subscribe(() => {
  demoVersion++;
});

/** Changes whenever the demo timeline or demo reviews change (always 0 outside demo mode). */
export function useDemoVersion(): number {
  return useSyncExternalStore(
    demoStore.subscribe,
    () => demoVersion,
    () => 0,
  );
}

export function useDemoStep(): number {
  return useSyncExternalStore(
    demoStore.subscribe,
    () => demoStore.getStep(),
    () => demoStore.getStep(),
  );
}
