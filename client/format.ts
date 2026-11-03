import type { Step, Tokens } from "../shared/contract";

// Pure formatters: no React, no React Native, so tests/format.test.ts runs them in Node. Wording and number
// formats follow Claude Code's desktop app (its en-US catalog and formatters).

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const dropPointZero = (fixed: string) => (fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed);

/** 0, 950, 1.2k, 12k, 123.5k, 1.2M, 3.4B: one decimal, ".0" dropped; rounding never prints "1000k". */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const count = Math.round(value);
  if (count >= 1e9) return `${dropPointZero((count / 1e9).toFixed(1))}B`;
  if (count >= 1e6) {
    const millions = Number((count / 1e6).toFixed(1));
    return millions >= 1e3 ? `${dropPointZero((count / 1e9).toFixed(1))}B` : `${dropPointZero(millions.toFixed(1))}M`;
  }
  if (count >= 1e3) {
    const thousands = Number((count / 1e3).toFixed(1));
    return thousands >= 1e3 ? `${dropPointZero((count / 1e6).toFixed(1))}M` : `${dropPointZero(thousands.toFixed(1))}k`;
  }
  return String(count);
}

const pad2 = (value: number) => String(value).padStart(2, "0");

const wholeSeconds = (ms: number) => (Number.isFinite(ms) ? Math.max(0, Math.round(ms / SECOND)) : 0);

/**
 * A finished duration: up to three units from the largest non-zero one, the later ones padded to two digits.
 * 0s, 7s, 1m 05s, 12m 00s, 1h 02m 05s, 2d 03h 10m.
 */
export function formatDuration(ms: number): string {
  const total = wholeSeconds(ms);
  const units: readonly [number, string][] = [
    [Math.floor(total / 86_400), "d"],
    [Math.floor((total % 86_400) / 3_600), "h"],
    [Math.floor((total % 3_600) / 60), "m"],
    [total % 60, "s"],
  ];
  const first = units.findIndex(([value]) => value > 0);
  if (first === -1) return "0s";
  return units
    .slice(first, first + 3)
    .map(([value, unit], index) => `${index === 0 ? value : pad2(value)}${unit}`)
    .join(" ");
}

/** A live elapsed time, as short as it can be: now, 45s, 1m 23s (seconds only under 5 min), 12m, 1h 5m, 2d 3h. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const seconds = wholeSeconds(ms);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest > 0 && minutes < 5 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest > 0 ? `${days}d ${rest}h` : `${days}d`;
}

/** Milliseconds since the epoch, or null for a missing or unparseable ISO string. */
export function parseTime(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined || iso === "") return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

/** "now", "12s ago", "3m ago", "2h ago", "4d ago"; "" when the time is unknown. */
export function formatAgo(iso: string | null | undefined, now: number): string {
  const time = parseTime(iso);
  if (time === null) return "";
  const age = now - time;
  if (age < 5 * SECOND) return "now";
  if (age < MINUTE) return `${Math.floor(age / SECOND)}s ago`;
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`;
  return `${Math.floor(age / DAY)}d ago`;
}

/** Start to end, or start to now while it runs; null without a start. */
export function elapsedMs(startedAt: string | null, endedAt: string | null, now: number): number | null {
  const start = parseTime(startedAt);
  if (start === null) return null;
  const end = parseTime(endedAt) ?? now;
  return Math.max(0, end - start);
}

/** Every token the API counted: input, output, cache read and cache write. */
export function sumTokens(tokens: Tokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/** "1 token", "45.2k tokens". */
export function tokenCount(count: number): string {
  return count === 1 ? "1 token" : `${formatTokens(count)} tokens`;
}

/** "1 tool call" / "12 tool calls": the transcript counter. */
export const toolCalls = (count: number) => plural(count, "tool call", "tool calls");

/** The detail view's counter line: "12 tool calls · 45.2k tokens · 1m 23s". */
export function transcriptFooter(toolCallCount: number, tokens: number, duration: string): string {
  return [toolCalls(toolCallCount), tokenCount(tokens), duration].filter(Boolean).join(" · ");
}

/** "12.3k in · 3.4k out · 1.2M cache read · 45k cache write · 88k context"; zero counters are left out. */
export function tokenBreakdown(tokens: Tokens, context: number | null): string {
  const parts: [number, string][] = [
    [tokens.input, "in"],
    [tokens.output, "out"],
    [tokens.cacheRead, "cache read"],
    [tokens.cacheWrite, "cache write"],
  ];
  const shown = parts.filter(([value]) => value > 0).map(([value, word]) => `${formatTokens(value)} ${word}`);
  if (context !== null && context > 0) shown.push(`${formatTokens(context)} context`);
  return shown.join(" · ");
}

const MODEL_FAMILIES = ["opus", "sonnet", "haiku"] as const;
const isVersionPart = (part: string) => /^\d{1,2}$/.test(part);

/**
 * "claude-opus-4-5-20251101" -> "Opus 4.5", "claude-3-5-haiku-20241022" -> "Haiku 3.5", "opus" -> "Opus". A name
 * that is not a Claude family is returned unchanged.
 */
export function shortModel(model: string): string {
  const parts = model.toLowerCase().replace(/\[[^\]]*\]$/, "").split(/[-_.:@/\s]+/).filter((part) => part !== "");
  const index = parts.findIndex((part) => (MODEL_FAMILIES as readonly string[]).includes(part));
  if (index === -1) return model;
  const after: string[] = [];
  for (let at = index + 1; at < parts.length && isVersionPart(parts[at]); at += 1) after.push(parts[at]);
  const before: string[] = [];
  for (let at = index - 1; at >= 0 && isVersionPart(parts[at]); at -= 1) before.unshift(parts[at]);
  const version = (after.length > 0 ? after : before).join(".");
  const family = parts[index];
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return version === "" ? name : `${name} ${version}`;
}

/** "mcp__github__search_issues" -> "github · search_issues"; other names unchanged. */
export function toolDisplayName(tool: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool);
  return match ? `${match[1]} · ${match[2]}` : tool;
}

/** What a step is, in one word: the tool name, "Text" or "Thinking". */
export function stepName(step: Pick<Step, "kind" | "tool">): string {
  if (step.kind === "thinking") return "Thinking";
  if (step.kind === "text") return "Text";
  return step.tool === null ? "Tool" : toolDisplayName(step.tool);
}

/** The step title without a leading copy of the tool name ("StructuredOutput {…}" -> "{…}"). */
export function stepTitle(step: Pick<Step, "kind" | "tool" | "title">): string {
  const name = stepName(step);
  const title = step.title.trim();
  const rest = title.slice(name.length);
  return title.startsWith(name) && (rest === "" || /^[\s:({]/.test(rest)) ? rest.replace(/^[\s:]+/, "") : title;
}

const FILE_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * The step title for one-line rows: a file tool's file name, since a sidebar cuts a full path before it; every other
 * title as stepTitle gives it. Labels and the detail view keep the full title.
 */
export function stepSubject(step: Pick<Step, "kind" | "tool" | "title">): string {
  const title = stepTitle(step);
  return step.kind === "tool" && step.tool !== null && FILE_TOOLS.has(step.tool) && title !== "" ? basename(title) : title;
}

/** "Bash · Run tsc --noEmit", "Read · notes.md", for one-line current-step displays. */
export function stepLine(step: Pick<Step, "kind" | "tool" | "title">): string {
  const subject = stepSubject(step);
  return subject === "" ? stepName(step) : `${stepName(step)} · ${subject}`;
}

/** Last path segment: "/Users/a/Documents/my-repo/" -> "my-repo". */
export function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== "");
  return parts.length === 0 ? path : parts[parts.length - 1];
}

/** "1 tool" / "3 tools". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
