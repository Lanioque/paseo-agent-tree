import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

// One AppState subscription shared by every poller of the plugin (panels, screen, clock, composer pills), opened by
// the first subscriber and closed by the last. refetchOnWindowFocus does nothing on Android, so polling is gated here.

const isActive = () => AppState.currentState === "active";

let active = isActive();
const listeners = new Set<() => void>();
let subscription: { remove(): void } | null = null;

/** Calls `listener` whenever the app enters or leaves the foreground. Returns the unsubscribe. */
export function subscribeForeground(listener: () => void): () => void {
  listeners.add(listener);
  if (subscription === null) {
    active = isActive();
    subscription = AppState.addEventListener("change", (state) => {
      const next = state === "active";
      if (next === active) return;
      active = next;
      for (const notify of listeners) notify();
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && subscription !== null) {
      subscription.remove();
      subscription = null;
    }
  };
}

/** True while the app is in the foreground. */
export const isForeground = () => active;

/** True while the app is in the foreground. */
export function useForeground(): boolean {
  return useSyncExternalStore(subscribeForeground, isForeground, isForeground);
}
