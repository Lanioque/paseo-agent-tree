import type { Reducer } from "./jsonl";
import { str } from "./format";

// subagents/workflows/<runId>/journal.jsonl: {type:"started", key, agentId, label, phase}, then {type:"result", key,
// agentId, result} or {type:"failed", key, agentId}. A retry or a resume starts the same key again under a new
// agentId (a resume can also repeat "started" for the same agent). Other types ({type:"launched"}…) are ignored.

export interface JournalAgent {
  agentId: string;
  /** The journal key: one unit of work of the script, kept across its attempts. */
  key: string | null;
  label: string | null;
  phase: string | null;
  /** Set once a result line arrived; `value` is the raw result (null when the agent returned nothing). */
  result: { value: unknown } | null;
  /** A "failed" line arrived for this attempt. */
  failed: boolean;
}

export interface JournalState {
  /** In first-seen order. */
  agents: Map<string, JournalAgent>;
  /** Key → agentId of its latest attempt, for result lines that carry only the key. */
  keys: Map<string, string>;
  weight: number;
}

export function createJournalState(): JournalState {
  return { agents: new Map(), keys: new Map(), weight: 0 };
}

function agentFor(state: JournalState, agentId: string): JournalAgent {
  let agent = state.agents.get(agentId);
  if (!agent) {
    agent = { agentId, key: null, label: null, phase: null, result: null, failed: false };
    state.agents.set(agentId, agent);
    state.weight += 64;
  }
  return agent;
}

export const journalReducer: Reducer<JournalState> = {
  create: createJournalState,
  weight: (state) => state.weight,
  apply(state, line) {
    const type = line.type;
    if (type !== "started" && type !== "result" && type !== "failed") return;
    const key = str(line.key);
    const agentId = str(line.agentId) ?? (key ? state.keys.get(key) ?? null : null);
    if (!agentId) return;
    if (key && (type === "started" || !state.keys.has(key))) state.keys.set(key, agentId);
    const agent = agentFor(state, agentId);
    agent.key = key ?? agent.key;
    if (type === "started") {
      agent.label = str(line.label) ?? agent.label;
      agent.phase = str(line.phase) ?? agent.phase;
    } else if (type === "failed") {
      agent.failed = true;
    } else {
      const value = "result" in line ? line.result : null;
      agent.result = { value };
      state.weight += typeof value === "string" ? value.length : 2048;
    }
  },
};

/** A result of null or "null" means the agent ended without returning anything: counted as failed. */
export function resultFailed(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "null");
}

/** Readable text of a journal result: a string as is, an object's summary when it has one, else compact JSON. */
export function resultString(value: unknown): string | null {
  if (resultFailed(value)) return null;
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["summary", "result", "text", "message"]) {
      const field = record[key];
      if (typeof field === "string" && field) return field;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
