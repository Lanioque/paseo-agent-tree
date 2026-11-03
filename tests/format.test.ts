import { describe, expect, it } from "vitest";
import {
  basename,
  elapsedMs,
  formatAgo,
  formatDuration,
  formatElapsed,
  formatTokens,
  parseTime,
  plural,
  shortModel,
  stepLine,
  stepSubject,
  stepName,
  stepTitle,
  sumTokens,
  tokenBreakdown,
  tokenCount,
  toolCalls,
  toolDisplayName,
  transcriptFooter,
} from "../client/format";

// Client formatters only (client/format.ts). Expected strings follow Claude Code's desktop app.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatTokens", () => {
  it("keeps small counts whole", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(7)).toBe("7");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(999.4)).toBe("999");
  });

  it("uses one decimal and drops a trailing .0", () => {
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(45_200)).toBe("45.2k");
    expect(formatTokens(12_000)).toBe("12k");
    expect(formatTokens(123_456)).toBe("123.5k");
    expect(formatTokens(1_240_000)).toBe("1.2M");
    expect(formatTokens(12_400_000)).toBe("12.4M");
    expect(formatTokens(3_400_000_000)).toBe("3.4B");
  });

  it("moves to the next unit instead of printing 1000k", () => {
    expect(formatTokens(999.6)).toBe("1k");
    expect(formatTokens(999_960)).toBe("1M");
    expect(formatTokens(999_960_000)).toBe("1B");
  });

  it("reads bad input as zero", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("formatDuration (finished work)", () => {
  it("shows up to three units, the later ones padded", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(400)).toBe("0s");
    expect(formatDuration(7 * SECOND)).toBe("7s");
    expect(formatDuration(83 * SECOND)).toBe("1m 23s");
    expect(formatDuration(65 * SECOND)).toBe("1m 05s");
    expect(formatDuration(12 * MINUTE)).toBe("12m 00s");
    expect(formatDuration(HOUR + 2 * MINUTE + 5 * SECOND)).toBe("1h 02m 05s");
    expect(formatDuration(2 * DAY + 3 * HOUR + 10 * MINUTE + 30 * SECOND)).toBe("2d 03h 10m");
  });

  it("rounds to the second and clamps bad input to 0s", () => {
    expect(formatDuration(59_600)).toBe("1m 00s");
    expect(formatDuration(-3_000)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});

describe("formatElapsed (live work)", () => {
  it("is as short as it can be", () => {
    expect(formatElapsed(0)).toBe("now");
    expect(formatElapsed(-50)).toBe("now");
    expect(formatElapsed(45 * SECOND)).toBe("45s");
    expect(formatElapsed(83 * SECOND)).toBe("1m 23s");
    expect(formatElapsed(3 * MINUTE)).toBe("3m");
    expect(formatElapsed(12 * MINUTE + 40 * SECOND)).toBe("12m");
    expect(formatElapsed(HOUR + 5 * MINUTE)).toBe("1h 5m");
    expect(formatElapsed(2 * HOUR)).toBe("2h");
    expect(formatElapsed(2 * DAY + 3 * HOUR)).toBe("2d 3h");
    expect(formatElapsed(3 * DAY)).toBe("3d");
  });
});

describe("relative times", () => {
  const now = Date.parse("2026-11-03T10:00:00Z");

  it("says how long ago", () => {
    expect(formatAgo("2026-11-03T09:59:58Z", now)).toBe("now");
    expect(formatAgo("2026-11-03T09:59:30Z", now)).toBe("30s ago");
    expect(formatAgo("2026-11-03T09:57:00Z", now)).toBe("3m ago");
    expect(formatAgo("2026-11-03T08:00:00Z", now)).toBe("2h ago");
    expect(formatAgo("2026-10-30T10:00:00Z", now)).toBe("4d ago");
  });

  it("treats future times as now and unknown times as empty", () => {
    expect(formatAgo("2026-11-03T10:05:00Z", now)).toBe("now");
    expect(formatAgo(null, now)).toBe("");
    expect(formatAgo("not a date", now)).toBe("");
    expect(parseTime("")).toBeNull();
  });

  it("measures elapsed time to the end, or to now while running", () => {
    expect(elapsedMs("2026-11-03T09:58:00Z", "2026-11-03T09:59:05Z", now)).toBe(65_000);
    expect(elapsedMs("2026-11-03T09:58:00Z", null, now)).toBe(120_000);
    expect(elapsedMs(null, null, now)).toBeNull();
  });
});

describe("counters", () => {
  it("counts tool calls and tokens in Claude Code's words", () => {
    expect(toolCalls(1)).toBe("1 tool call");
    expect(toolCalls(12)).toBe("12 tool calls");
    expect(tokenCount(1)).toBe("1 token");
    expect(tokenCount(45_200)).toBe("45.2k tokens");
  });

  it("prints the transcript counter line", () => {
    expect(transcriptFooter(12, 45_200, "1m 23s")).toBe("12 tool calls · 45.2k tokens · 1m 23s");
    expect(transcriptFooter(1, 1, "")).toBe("1 tool call · 1 token");
  });

  it("breaks tokens down, leaving out zero counters", () => {
    expect(tokenBreakdown({ input: 12_300, output: 3_400, cacheRead: 1_200_000, cacheWrite: 45_000 }, 88_000)).toBe(
      "12.3k in · 3.4k out · 1.2M cache read · 45k cache write · 88k context",
    );
    expect(tokenBreakdown({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, null)).toBe("10 in");
  });

  it("sums every token counter", () => {
    expect(sumTokens({ input: 10, output: 20, cacheRead: 300, cacheWrite: 4 })).toBe(334);
  });
});

describe("shortModel", () => {
  it("names the family and its version", () => {
    expect(shortModel("claude-opus-4-5-20251101")).toBe("Opus 4.5");
    expect(shortModel("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    expect(shortModel("claude-3-5-haiku-20241022")).toBe("Haiku 3.5");
    expect(shortModel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(shortModel("claude-sonnet-4-5[1m]")).toBe("Sonnet 4.5");
    expect(shortModel("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("Haiku 4.5");
    expect(shortModel("opus")).toBe("Opus");
  });

  it("leaves other names unchanged", () => {
    expect(shortModel("gpt-5")).toBe("gpt-5");
  });
});

describe("labels", () => {
  it("shortens MCP tool names and names text and thinking steps", () => {
    expect(toolDisplayName("mcp__github__search_issues")).toBe("github · search_issues");
    expect(toolDisplayName("Bash")).toBe("Bash");
    expect(stepName({ kind: "thinking", tool: null })).toBe("Thinking");
    expect(stepName({ kind: "text", tool: null })).toBe("Text");
  });

  it("joins the step name and title on one line", () => {
    expect(stepLine({ kind: "tool", tool: "Bash", title: "Run tsc --noEmit" })).toBe("Bash · Run tsc --noEmit");
    expect(stepLine({ kind: "tool", tool: "Read", title: "  " })).toBe("Read");
    expect(stepLine({ kind: "tool", tool: "StructuredOutput", title: "StructuredOutput {\"a\":1}" })).toBe('StructuredOutput · {"a":1}');
    expect(stepTitle({ kind: "tool", tool: "Bash", title: "Bash: ls" })).toBe("ls");
    expect(stepTitle({ kind: "text", tool: null, title: "Textual analysis" })).toBe("Textual analysis");
  });

  it("names a file tool's file, not its whole path, on one-line rows", () => {
    const read = { kind: "tool", tool: "Read", title: "/var/folders/ab/cdefgh/T/scratch/todo.js" } as const;
    expect(stepSubject(read)).toBe("todo.js");
    expect(stepLine(read)).toBe("Read · todo.js");
    expect(stepTitle(read)).toBe(read.title);
    expect(stepLine({ kind: "tool", tool: "Edit", title: "~/Documents/paseo-agent-tree/client/rows.ts" })).toBe("Edit · rows.ts");
    expect(stepSubject({ kind: "tool", tool: "Grep", title: "TODO in /work/src" })).toBe("TODO in /work/src");
  });

  it("takes the last path segment and pluralises", () => {
    expect(basename("/Users/a/Documents/my-repo/")).toBe("my-repo");
    expect(basename("C:\\work\\repo")).toBe("repo");
    expect(plural(1, "tool", "tools")).toBe("1 tool");
    expect(plural(3, "tool", "tools")).toBe("3 tools");
  });
});
