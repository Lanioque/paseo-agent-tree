import type { AgentNode, BackgroundTask, Phase, RunStatus, SessionTree, Step, Workflow } from "../shared/contract";
import { formatDuration, parseTime, plural, shortModel, stepLine, sumTokens, tokenCount } from "./format";
import type { Tone } from "./looks";

// Pure view-model of the sidebar: which rows show, in what order, and what their lines say. No React, so
// tests/rows.test.ts runs it in Node.

/** Rows shown before a "Show more" row. */
export const ROW_LIMIT = 10;

/** A running agent with no activity for this long is drawn as stalled. */
const STALL_MS = 90_000;

export interface Timing {
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  lastActivityAt?: string | null;
}

const LATE = Number.MAX_SAFE_INTEGER;

const startOf = (timing: Timing) => parseTime(timing.startedAt) ?? LATE;
const endOf = (timing: Timing) =>
  parseTime(timing.endedAt) ?? parseTime(timing.lastActivityAt) ?? parseTime(timing.startedAt) ?? -LATE;

/**
 * Running rows oldest first, then queued ones, then the finished ones newest first. With `fold` (a section while
 * anything in it runs or waits), failures stay in view and the other finished rows fold under "{n} finished".
 */
export function splitRows<T>(items: readonly T[], timing: (item: T) => Timing, fold: boolean): { shown: T[]; folded: T[] } {
  const byStart = (a: T, b: T) => startOf(timing(a)) - startOf(timing(b));
  const byEndDesc = (a: T, b: T) => endOf(timing(b)) - endOf(timing(a));
  const withStatus = (...statuses: RunStatus[]) => items.filter((item) => statuses.includes(timing(item).status));
  const finished = withStatus("failed", "done", "stopped", "unknown").sort(byEndDesc);
  const head = [...withStatus("running").sort(byStart), ...withStatus("pending")];
  if (!fold) return { shown: [...head, ...finished], folded: [] };
  return {
    shown: [...head, ...finished.filter((item) => timing(item).status === "failed")],
    folded: finished.filter((item) => timing(item).status !== "failed"),
  };
}

/** Anything in the list running or waiting to run. */
export function hasLive<T>(items: readonly T[], timing: (item: T) => Timing): boolean {
  return items.some((item) => {
    const { status } = timing(item);
    return status === "running" || status === "pending";
  });
}

/** The first ROW_LIMIT rows unless the list is opened in full; `more` says a "Show more" row is needed. */
export function limitRows<T>(rows: readonly T[], showAll: boolean): { rows: readonly T[]; more: boolean } {
  const more = rows.length > ROW_LIMIT;
  return { rows: more && !showAll ? rows.slice(0, ROW_LIMIT) : rows, more };
}

/** Background tasks that are not already listed as a workflow or a subagent. */
export function visibleTasks(tree: SessionTree): BackgroundTask[] {
  const workflowTasks = new Set(tree.workflows.map((workflow) => workflow.taskId).filter((id) => id !== null));
  const subagentIds = new Set(tree.subagents.map((agent) => agent.id));
  return tree.tasks.filter(
    (task) => !(task.kind === "workflow" && workflowTasks.has(task.id)) && !(task.kind === "agent" && subagentIds.has(task.id)),
  );
}

/** One row of the "Background tasks" list: a workflow run, a subagent or a background task, keyed per kind. */
export type TreeItem =
  | { kind: "workflow"; key: string; workflow: Workflow }
  | { kind: "agent"; key: string; node: AgentNode }
  | { kind: "task"; key: string; task: BackgroundTask };

/** Workflows, subagents and the other background tasks as one list, as Claude Code lists them. */
export function treeItems(tree: SessionTree): TreeItem[] {
  return [
    ...tree.workflows.map((workflow): TreeItem => ({ kind: "workflow", key: `workflow:${workflow.runId}`, workflow })),
    ...tree.subagents.map((node): TreeItem => ({ kind: "agent", key: `agent:${node.id}`, node })),
    ...visibleTasks(tree).map((task): TreeItem => ({ kind: "task", key: `task:${task.id}`, task })),
  ];
}

export function itemTiming(item: TreeItem): Timing {
  switch (item.kind) {
    case "workflow":
      return item.workflow;
    case "agent":
      return item.node;
    case "task":
      return item.task;
  }
}

/** Agents (workflow agents and subagents) and listed background tasks that run now. */
export function runningTotal(tree: SessionTree, tasks: readonly BackgroundTask[]): number {
  return tree.counts.running + tasks.filter((task) => task.status === "running").length;
}

export interface Part {
  text: string;
  tone: Tone;
}

const muted = (text: string): Part => ({ text, tone: "muted" });

/** The Main row's second line: ["3 running", "1.2M tokens"]. */
export function summaryParts(running: number, tokens: number): Part[] {
  return [...(running > 0 ? [muted(`${running} running`)] : []), muted(tokenCount(tokens))];
}

/** A section's summary while it is collapsed: "2 running", else the number of finished rows. */
export function sectionSummary(statuses: readonly RunStatus[]): string {
  const running = statuses.filter((status) => status === "running").length;
  return running > 0 ? `${running} running` : `${statuses.length} finished`;
}

/** Start to end in ms; null when either end is unknown. */
export function spanMs(startedAt: string | null, endedAt: string | null): number | null {
  const start = parseTime(startedAt);
  const end = parseTime(endedAt);
  return start === null || end === null ? null : Math.max(0, end - start);
}

/**
 * Right of the title, as in Claude Code's line rows: the live elapsed time while it runs, the duration once it
 * completed, Failed, Stopped or Queued otherwise. `span` is the finished run's length in ms, null when unknown.
 */
export type Trailing = { kind: "live" } | { kind: "duration"; text: string } | { kind: "word"; word: string; tone: Tone } | null;

export function trailingFor(status: RunStatus, span: number | null): Trailing {
  switch (status) {
    case "running":
      return { kind: "live" };
    case "failed":
      return { kind: "word", word: "Failed", tone: "danger" };
    case "stopped":
      return { kind: "word", word: "Stopped", tone: "muted" };
    case "pending":
      return { kind: "word", word: "Queued", tone: "muted" };
    case "done":
    case "unknown":
      return span === null ? null : { kind: "duration", text: formatDuration(span) };
  }
}

/** An agent's run length: to its end, or to its last activity when it stopped without one. */
export const agentSpan = (node: AgentNode) => spanMs(node.startedAt, node.endedAt ?? node.lastActivityAt);

/**
 * An agent row's second line: what it does now while it runs; once it finished, its model when it differs from the
 * session's and its tokens ("Haiku 4.5", "45.2k tokens"); nothing while queued.
 */
export function agentSecondLine(node: AgentNode, sessionModel: string | null): Part[] {
  if (node.status === "pending") return [];
  if (node.status === "running") return [muted(node.currentStep ? stepLine(node.currentStep) : "Starting…")];
  const parts: Part[] = [];
  if (node.model !== null && (sessionModel === null || shortModel(node.model) !== shortModel(sessionModel))) parts.push(muted(shortModel(node.model)));
  const tokens = sumTokens(node.tokens);
  if (tokens > 0) parts.push(muted(tokenCount(tokens)));
  return parts;
}

/** Claude Code's task notification endings, as a short status. Several end the same way, so the order matters. */
const TASK_ENDINGS: readonly [RegExp, (match: RegExpExecArray) => string][] = [
  [/completed \(exit code (\d+)[^)]*\)$/, (match) => `exit ${match[1]}`],
  [/failed with exit code (\d+)$/, (match) => `exit ${match[1]}`],
  [/was stopped after reaching its background time limit$/, () => "time limit"],
  [/didn't finish before the previous session ended$/, () => "session ended"],
  [/(?:completed|finished|was stopped|stream ended)$/, () => ""],
];

/** A notification sentence that quotes its task: 'Background command "…', 'Agent "…', 'Monitor "…'. */
const QUOTING = /^[A-Z][A-Za-z ]*"/;
/** Longer than this, what follows the quoted title is not a short status. */
const NOTE_MAX = 40;

/**
 * What Claude Code's notification adds to a finished task's row, in a few words: "exit 1", "time limit". Its
 * sentence repeats the title ('Background command "Build" completed (exit code 0)'), so only the ending is kept, and
 * "exit 0" of a completed command says nothing the duration does not. A sentence that was cut (the server keeps 200
 * characters) or quotes the command HTML-escaped leaves nothing short, so it gives no note.
 */
export function taskNote(task: Pick<BackgroundTask, "status" | "title" | "summary">): string {
  if (task.status === "running" || task.status === "pending" || task.summary === null) return "";
  const summary = task.summary.trim().replace(/\.$/, "");
  for (const [pattern, note] of TASK_ENDINGS) {
    const match = pattern.exec(summary);
    if (match) {
      const text = note(match);
      return task.status === "done" && text === "exit 0" ? "" : text;
    }
  }
  const quoted = `"${task.title}"`;
  const at = summary.indexOf(quoted);
  const rest = at !== -1 ? summary.slice(at + quoted.length).trim() : summary.startsWith(task.title) ? summary.slice(task.title.length).trim() : null;
  if (rest !== null) return rest.length <= NOTE_MAX ? rest : "";
  return QUOTING.test(summary) ? "" : summary;
}

/** A finished step's duration, left out under a second so quick reads do not all say "0s". */
export function stepDuration(step: Pick<Step, "status" | "at" | "endedAt">): string {
  if (step.status === "running") return "";
  const span = spanMs(step.at, step.endedAt);
  return span === null || span < 1_000 ? "" : formatDuration(span);
}

/**
 * A workflow row's second line: "6/10 agents", "1 failed", "2 stalled", "1.2M tokens" while it runs, the agent total
 * after. Stalled agents get words as well as their warning cells, so colour is never the only cue.
 */
export function workflowParts(workflow: Workflow, cells: readonly CellState[]): Part[] {
  const { total, done, failed } = workflow.agentCounts;
  const running = workflow.status === "running";
  if (total === 0) return [muted(running ? "Waiting for agents to start" : "No agents ran")];
  const parts: Part[] = [muted(running ? `${done}/${total} agents` : plural(total, "agent", "agents"))];
  if (failed > 0) parts.push({ text: `${failed} failed`, tone: "danger" });
  const stalled = cells.filter((cell) => cell === "stalled").length;
  if (stalled > 0) parts.push({ text: `${stalled} stalled`, tone: "warning" });
  const tokens = sumTokens(workflow.tokens);
  if (tokens > 0) parts.push(muted(tokenCount(tokens)));
  return parts;
}

export type CellState = "done" | "running" | "stalled" | "failed" | "stopped" | "pending";

/** One workflow agent as a progress cell; `now` is the tree's generation time, so a re-render does not change it. */
export function cellState(node: Pick<AgentNode, "status" | "startedAt" | "lastActivityAt">, now: number): CellState {
  switch (node.status) {
    case "running": {
      const last = parseTime(node.lastActivityAt) ?? parseTime(node.startedAt);
      return last !== null && now - last > STALL_MS ? "stalled" : "running";
    }
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "pending":
    case "unknown":
      return "pending";
  }
}

export function workflowCells(workflow: Workflow, now: number): CellState[] {
  return workflow.phases.flatMap((phase) => phase.agents.map((agent) => cellState(agent, now)));
}

/** The cells' accessible summary: "3 of 10 agents done, 2 running, 1 stalled, 1 failed". */
export function cellsSummary(cells: readonly CellState[]): string {
  const count = (state: CellState) => cells.filter((cell) => cell === state).length;
  return `${count("done")} of ${cells.length} agents done, ${count("running")} running, ${count("stalled")} stalled, ${count("failed")} failed`;
}

const NO_PHASE = "(no phase)";

/** A phase's sub-header title; none when the workflow has a single phase, "Other agents" for agents without one. */
export function phaseHeading(phase: Phase, phaseCount: number): string | null {
  if (phaseCount <= 1) return null;
  return phase.title === NO_PHASE ? "Other agents" : phase.title;
}

/** Right of a phase sub-header: "{done}/{total}", or why it has no agent. */
export function phaseProgress(phase: Phase): { short: string; sentence: string } {
  const total = phase.agents.length;
  if (total > 0) {
    const done = phase.agents.filter((agent) => agent.status === "done").length;
    return { short: `${done}/${total}`, sentence: `${done} of ${total} done` };
  }
  if (phase.status === "pending") return { short: "Not started", sentence: "No agents have started yet" };
  return { short: "Not run", sentence: "No agents ran in this phase" };
}

/** Equal own fields, compared with ===: a poll's fresh copy of an unchanged flat record. */
export function sameFlat<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** An agent node unchanged since the last poll, so its memoised row can skip rendering. */
export function sameNode(a: AgentNode, b: AgentNode): boolean {
  if (a === b) return true;
  const { tokens: tokensA, currentStep: stepA, ...restA } = a;
  const { tokens: tokensB, currentStep: stepB, ...restB } = b;
  const sameStep = stepA === stepB || (stepA !== null && stepB !== null && sameFlat(stepA, stepB));
  return sameStep && sameFlat(tokensA, tokensB) && sameFlat(restA, restB);
}
