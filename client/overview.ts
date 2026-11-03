import type { RpcOutput } from "@getpaseo/plugin";
import { useSyncExternalStore } from "react";
import type { runsOverviewRpc, SessionSummary } from "../shared/contract";

export type RunsOverview = RpcOutput<typeof runsOverviewRpc>;

/**
 * The latest runs.overview of one plugin installation, shared by the composer pills, the sidebar badge and the
 * runs screen. Whoever reads the daemon publishes here, so one fresh read updates every consumer.
 */
export interface OverviewStore {
  publish(overview: RunsOverview): void;
  sessions(): readonly SessionSummary[];
  subscribe(listener: () => void): () => void;
}

export function createOverviewStore(): OverviewStore {
  let sessions: readonly SessionSummary[] = [];
  const listeners = new Set<() => void>();
  return {
    publish(overview) {
      sessions = overview.sessions;
      for (const notify of listeners) notify();
    },
    sessions: () => sessions,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Running agents (workflow agents and subagents) over every session, or of one Paseo agent. */
export function runningAgents(sessions: readonly SessionSummary[], agentId?: string): number {
  return sessions
    .filter((session) => agentId === undefined || session.agentId === agentId)
    .reduce((sum, session) => sum + session.counts.running, 0);
}

export function useRunningTotal(store: OverviewStore): number {
  const read = () => runningAgents(store.sessions());
  return useSyncExternalStore(store.subscribe, read, read);
}
