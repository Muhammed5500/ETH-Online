/**
 * Polling that stops when nothing more can happen.
 *
 * A settled market never changes again, so polling it forever is a request per
 * second buying nothing. More to the point, the demo will have several tabs
 * open at once during a video and the API is the same process the orchestrator
 * runs in.
 *
 * Two other things this handles that a bare `setInterval` does not:
 *
 *   A slow response never overlaps the next tick. The timer is set AFTER the
 *   request resolves, so a request that takes longer than the interval cannot
 *   pile up behind itself.
 *
 *   A failed poll keeps the last good data on screen. A market page that
 *   blanks out because one request lost a race is worse than a page showing
 *   data a second old.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollingState<T> {
  readonly data: T | undefined;
  readonly error: Error | undefined;
  readonly loading: boolean;
  /** True once at least one request has finished, however it went. */
  readonly settled: boolean;
  refresh: () => void;
}

export interface PollingOptions {
  readonly intervalMs?: number;
  /** Polling stops when this is false. Defaults to always on. */
  readonly enabled?: boolean;
}

export function usePolling<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
  opts: PollingOptions = {},
): PollingState<T> {
  const intervalMs = opts.intervalMs ?? 2000;
  const enabled = opts.enabled ?? true;

  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [settled, setSettled] = useState(false);
  const [tick, setTick] = useState(0);

  // Kept in a ref so changing the fetcher identity every render does not
  // restart the loop; the deps array is what decides that.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async (): Promise<void> => {
      try {
        const next = await fetcherRef.current();
        if (cancelled) return;
        setData(next);
        setError(undefined);
      } catch (e) {
        if (cancelled) return;
        // Deliberately leaves `data` alone. Stale beats blank.
        setError(e as Error);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setSettled(true);
          if (enabled) timer = setTimeout(() => void run(), intervalMs);
        }
      }
    };

    setLoading(true);
    void run();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, enabled, tick]);

  return { data, error, loading, settled, refresh };
}

/** A market in one of these states will never change again. */
export function isTerminal(status: string | undefined): boolean {
  return status === 'settled' || status === 'cancelled';
}
