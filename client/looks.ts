import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import type { BackgroundTask, RunStatus, Step } from "../shared/contract";
import type { Colors } from "./theme";

// The single table from a state to its Lucide glyph, its colour token and its word. As in Claude Code, finished
// work is neutral (no green): accent marks what runs, danger what failed. Every state also has its own glyph shape
// and a word, so colour is never the only cue, and the word is the glyph's accessible name. Tree rows carry no state
// glyph: like Claude Code's, they lead with what the row is (kindIcons) and say the state in words on the right.

export type Tone = "accent" | "warning" | "danger" | "muted";

export interface Look {
  icon: string;
  tone: Tone;
  word: string;
}

export function toneColor(tone: Tone, colors: Colors): string {
  switch (tone) {
    case "accent":
      return colors.accent;
    case "warning":
      return colors.statusWarning;
    case "danger":
      return colors.statusDanger;
    case "muted":
      return colors.foregroundMuted;
  }
}

export const runLooks: Record<RunStatus, Look> = {
  running: { icon: "CircleDot", tone: "accent", word: "Running" },
  done: { icon: "CircleCheck", tone: "muted", word: "Completed" },
  failed: { icon: "CircleX", tone: "danger", word: "Failed" },
  stopped: { icon: "CircleSlash", tone: "muted", word: "Stopped" },
  pending: { icon: "CircleDashed", tone: "muted", word: "Queued" },
  unknown: { icon: "Circle", tone: "muted", word: "Unknown" },
};

/** Paseo's own status of the main agent (useAgent), which can differ from what the transcript shows. */
const paseoLooks: Record<PluginAgentSnapshot["status"], Look> = {
  initializing: { icon: "CircleDashed", tone: "muted", word: "Starting" },
  running: { icon: "CircleDot", tone: "accent", word: "Running" },
  idle: { icon: "Circle", tone: "muted", word: "Idle" },
  error: { icon: "CircleX", tone: "danger", word: "Error" },
  closed: { icon: "CircleSlash", tone: "muted", word: "Closed" },
};

/** lastStatus strings from Paseo agent records (runs.overview), falling back to a neutral look. */
export function paseoStatusLook(status: string | null): Look {
  if (status !== null && status in paseoLooks) return paseoLooks[status as PluginAgentSnapshot["status"]];
  return { icon: "Circle", tone: "muted", word: status ?? "Unknown" };
}

export const taskKindWords: Record<BackgroundTask["kind"], string> = {
  shell: "Shell",
  agent: "Agent",
  workflow: "Workflow",
  other: "Task",
};

/** A row's leading icon, as Claude Code's: its agents icon for agents, workflows and other tasks, a terminal for shells. */
export const AGENT_ICON = "Bot";
export const kindIcons: Record<BackgroundTask["kind"], string> = {
  shell: "SquareTerminal",
  agent: AGENT_ICON,
  workflow: AGENT_ICON,
  other: AGENT_ICON,
};

const toolIcons: Record<string, string> = {
  Bash: "SquareTerminal",
  BashOutput: "SquareTerminal",
  KillShell: "SquareTerminal",
  Read: "FileText",
  Write: "FilePen",
  Edit: "FilePen",
  MultiEdit: "FilePen",
  NotebookEdit: "FilePen",
  Grep: "Search",
  Glob: "FileSearch",
  WebFetch: "Globe",
  WebSearch: "Globe",
  Agent: "Bot",
  Task: "Bot",
  Workflow: "Workflow",
  TodoWrite: "ListTodo",
  TaskCreate: "ListTodo",
  TaskUpdate: "ListTodo",
  TaskList: "ListTodo",
  Skill: "Wrench",
};

/** The glyph of a step: its tool, an MCP plug, or text and thinking marks. */
export function stepIcon(step: Pick<Step, "kind" | "tool">): string {
  if (step.kind === "thinking") return "Brain";
  if (step.kind === "text") return "MessageSquare";
  if (step.tool === null) return "Wrench";
  if (step.tool.startsWith("mcp__")) return "Plug";
  return toolIcons[step.tool] ?? "Wrench";
}

export const stepStatusLooks: Record<Step["status"], Look> = {
  running: { icon: "CircleDot", tone: "accent", word: "Running" },
  ok: { icon: "Check", tone: "muted", word: "Done" },
  error: { icon: "CircleX", tone: "danger", word: "Error" },
};

export const errorLook: Look = { icon: "CircleX", tone: "danger", word: "Error" };
export const notFoundLook: Look = { icon: "CircleAlert", tone: "warning", word: "Not available" };
