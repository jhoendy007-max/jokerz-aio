import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Debounce a changing value (search boxes, filters, etc.).
 * UI stays instant; consumers of the debounced value update after `delayMs`.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}

/**
 * Debounced callback — cancels prior timers on each call.
 */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs = 300
): (...args: A) => void {
  const fnRef = useRef(fn);
  const timerRef = useRef<number>(0);
  fnRef.current = fn;

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  return useCallback(
    (...args: A) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        fnRef.current(...args);
      }, delayMs);
    },
    [delayMs]
  );
}
