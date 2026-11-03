import { useEffect, useState, useSyncExternalStore } from "react";
import { useForeground } from "./foreground";

// Live elapsed counters share one 1-second interval, started by the first live counter and stopped by the last,
// so a tree with ten running agents re-renders ten small Text nodes per second, not the whole panel.

let tickNow = Date.now();
const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;

function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);
  if (tickTimer === null) {
    tickNow = Date.now();
    tickTimer = setInterval(() => {
      tickNow = Date.now();
      for (const notify of tickListeners) notify();
    }, 1000);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}

const subscribeNever = () => () => {};
const readTick = () => tickNow;

/** The time, refreshed every second while `live` and the app is in the foreground; frozen otherwise. */
export function useSecondTick(live: boolean): number {
  const ticking = useForeground() && live;
  return useSyncExternalStore(ticking ? subscribeTick : subscribeNever, readTick, readTick);
}

/** The time, refreshed every `intervalMs` while the app is in the foreground and `shown` ("3m ago" labels). */
export function useNow(intervalMs: number, shown: boolean): number {
  const foreground = useForeground() && shown;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!foreground) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [foreground, intervalMs]);
  return now;
}

/** False for the first `ms` after mount, then true: a fast first read never flashes a loading state. */
export function useDelay(ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return elapsed;
}
