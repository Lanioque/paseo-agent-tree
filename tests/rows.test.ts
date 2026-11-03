import { describe, expect, it } from "vitest";
import {
  agentSecondLine,
  agentSpan,
  cellState,
  cellsSummary,
  hasLive,
  itemTiming,
  limitRows,
  phaseHeading,
  phaseProgress,
  ROW_LIMIT,
  runningTotal,
  sameNode,
  sectionSummary,
  splitRows,
  stepDuration,
  summaryParts,
  taskNote,
  trailingFor,
  treeItems,
  visibleTasks,
  workflowCells,
  workflowParts,
} from "../client/rows";
import type { AgentNode, BackgroundTask, Phase, RunStatus, SessionTree, Step, Workflow } from "../shared/contract";

// The sidebar's view-model (client/rows.ts): row order, folding, and what each line says.

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function node(id: string, status: RunStatus, extra: Partial<AgentNode> = {}): AgentNode {
  return {
    id,
    kind: "subagent",
    label: `Agent ${id}`,
    agentType: "general-purpose",
    phase: null,
    depth: 1,
    background: false,
    status,
    model: null,
    effort: null,
    startedAt: null,
    endedAt: null,
    lastActivityAt: null,
    currentStep: null,
    toolCalls: 0,
    turns: 0,
    tokens: zero,
    contextTokens: null,
    resultPreview: null,
    ...extra,
  };
}

function step(extra: Partial<Step> = {}): Step {
  return {
    id: "s1",
    at: "2026-11-03T10:00:00.000Z",
    endedAt: null,
    kind: "tool",
    tool: "Bash",
    title: "Run tests",
    detail: null,
    status: "running",
    resultPreview: null,
    ...extra,
  };
}

function task(id: string, status: RunStatus, extra: Partial<BackgroundTask> = {}): BackgroundTask {
  return { id, kind: "shell", title: `Task ${id}`, status, startedAt: null, endedAt: null, summary: null, ...extra };
}

function workflow(phases: Phase[], extra: Partial<Workflow> = {}): Workflow {
  return {
    runId: "wf_1",
    taskId: "t1",
    name: "audit",
    description: null,
    status: "running",
    startedAt: "2026-11-03T10:00:00.000Z",
    endedAt: null,
    phases,
    agentCounts: { total: 0, running: 0, done: 0, failed: 0 },
    tokens: zero,
    resultPreview: null,
    ...extra,
  };
}

function tree(extra: Partial<SessionTree> = {}): SessionTree {
  return {
    found: true,
    reason: null,
    sessionId: "s",
    cwd: "/tmp",
    model: "claude-opus-4-5",
    main: null,
    totalTokens: zero,
    workflows: [],
    subagents: [],
    tasks: [],
    todos: [],
    counts: { total: 0, running: 0, done: 0, failed: 0 },
    generatedAt: "2026-11-03T10:00:00.000Z",
    ...extra,
  };
}

const t = (minute: number) => `2026-11-03T10:${String(minute).padStart(2, "0")}:00.000Z`;
const ids = (nodes: readonly AgentNode[]) => nodes.map((item) => item.id);

describe("splitRows", () => {
  const nodes = [
    node("done-early", "done", { startedAt: t(0), endedAt: t(2) }),
    node("run-late", "running", { startedAt: t(5) }),
    node("failed", "failed", { startedAt: t(1), endedAt: t(3) }),
    node("run-early", "running", { startedAt: t(1) }),
    node("queued", "pending"),
    node("done-late", "done", { startedAt: t(2), endedAt: t(8) }),
    node("stopped", "stopped", { startedAt: t(0), lastActivityAt: t(4) }),
  ];

  it("folds finished rows while something runs, keeping failures in view", () => {
    const { shown, folded } = splitRows(nodes, (item) => item, true);
    expect(ids(shown)).toEqual(["run-early", "run-late", "queued", "failed"]);
    expect(ids(folded)).toEqual(["done-late", "stopped", "done-early"]);
  });

  it("lists everything, finished rows newest first, when nothing runs", () => {
    const finished = nodes.filter((item) => item.status !== "running" && item.status !== "pending");
    expect(hasLive(finished, (item) => item)).toBe(false);
    const { shown, folded } = splitRows(finished, (item) => item, false);
    expect(ids(shown)).toEqual(["done-late", "stopped", "failed", "done-early"]);
    expect(folded).toEqual([]);
  });

  it("knows when a list has live work", () => {
    expect(hasLive(nodes, (item) => item)).toBe(true);
    expect(hasLive([node("q", "pending")], (item) => item)).toBe(true);
  });
});

describe("limitRows", () => {
  const rows = Array.from({ length: ROW_LIMIT + 3 }, (_, index) => index);

  it("cuts long lists until they are opened in full", () => {
    expect(limitRows(rows, false)).toEqual({ rows: rows.slice(0, ROW_LIMIT), more: true });
    expect(limitRows(rows, true)).toEqual({ rows, more: true });
    expect(limitRows([1, 2], false)).toEqual({ rows: [1, 2], more: false });
  });
});

const texts = (parts: readonly { text: string }[]) => parts.map((part) => part.text);

describe("row lines", () => {
  it("puts the live time, the finished duration or a status word right of the title", () => {
    expect(trailingFor("running", null)).toEqual({ kind: "live" });
    expect(trailingFor("failed", 5_000)).toEqual({ kind: "word", word: "Failed", tone: "danger" });
    expect(trailingFor("stopped", 5_000)).toEqual({ kind: "word", word: "Stopped", tone: "muted" });
    expect(trailingFor("pending", null)).toEqual({ kind: "word", word: "Queued", tone: "muted" });
    expect(trailingFor("done", 83_000)).toEqual({ kind: "duration", text: "1m 23s" });
    expect(trailingFor("unknown", 300_000)).toEqual({ kind: "duration", text: "5m 00s" });
    expect(trailingFor("done", null)).toBeNull();
  });

  it("says what a running agent does now", () => {
    expect(texts(agentSecondLine(node("a", "running", { currentStep: step() }), null))).toEqual(["Bash · Run tests"]);
    expect(texts(agentSecondLine(node("a", "running", { currentStep: step({ tool: "Read", title: "/tmp/x/notes.md" }) }), null))).toEqual(["Read · notes.md"]);
    expect(texts(agentSecondLine(node("a", "running"), null))).toEqual(["Starting…"]);
    expect(agentSecondLine(node("a", "pending"), null)).toEqual([]);
  });

  it("gives a finished agent its model when it differs from the session's and its tokens; the duration goes right", () => {
    const finished = node("a", "done", {
      startedAt: "2026-11-03T10:00:00.000Z",
      endedAt: "2026-11-03T10:01:23.000Z",
      toolCalls: 12,
      tokens: { input: 200, output: 5_000, cacheRead: 40_000, cacheWrite: 0 },
      model: "claude-haiku-4-5-20251001",
    });
    expect(texts(agentSecondLine(finished, "claude-opus-4-5"))).toEqual(["Haiku 4.5", "45.2k tokens"]);
    expect(texts(agentSecondLine(finished, "claude-haiku-4-5"))).toEqual(["45.2k tokens"]);
    expect(agentSpan(finished)).toBe(83_000);
    expect(agentSecondLine(node("b", "stopped"), null)).toEqual([]);
    expect(agentSpan(node("c", "stopped", { startedAt: t(0), lastActivityAt: t(4) }))).toBe(4 * 60_000);
  });

  it("keeps only the ending of Claude Code's task notifications, which repeat the title", () => {
    const shell = (status: RunStatus, summary: string) => task("1", status, { title: "Build the app", summary });
    expect(taskNote(shell("done", 'Background command "Build the app" completed (exit code 0)'))).toBe("");
    expect(taskNote(shell("done", 'Background command "Build the app" completed (exit code 1: No matches found)'))).toBe("exit 1");
    expect(taskNote(shell("failed", 'Background command "Build the app" failed with exit code 2'))).toBe("exit 2");
    expect(taskNote(shell("stopped", 'Background command "Build the app" was stopped after reaching its background time limit'))).toBe("time limit");
    expect(taskNote(shell("stopped", 'Background command "Build the app" was stopped'))).toBe("");
    // Claude Code escapes the command it quotes, so the title is not always found in the sentence; the ending is.
    expect(taskNote(task("2", "failed", { title: "a && b", summary: 'Background command "a &amp;&amp; b" failed with exit code 1' }))).toBe("exit 1");
    expect(taskNote(task("3", "done", { kind: "agent", title: "Scan", summary: 'Agent "Scan" finished' }))).toBe("");
    expect(taskNote(task("4", "done", { kind: "other", title: "log tail", summary: 'Monitor "log tail" stream ended' }))).toBe("");
    expect(taskNote(task("5", "stopped", { kind: "workflow", title: "audit", summary: 'Background workflow "audit" (run wf_1) didn\'t finish before the previous session ended' }))).toBe("session ended");
    expect(taskNote(shell("done", 'Background command "Build the app" reported 3 warnings'))).toBe("reported 3 warnings");
    // The server keeps 200 characters of the sentence: a cut one has no ending left to read.
    const long = "cd /tmp/val-loop &amp;&amp; node bot.mjs &gt; run.log 2&gt;&amp;1; grep -E 'DONE' run.log | cut -c1-300";
    expect(taskNote(task("6", "done", { title: long.replace(/&amp;/g, "&").replace(/&gt;/g, ">"), summary: `Background command "${long}" completed (exit…` }))).toBe("");
    expect(taskNote(shell("done", "Linted 42 files, 3 warnings"))).toBe("Linted 42 files, 3 warnings");
    expect(taskNote(shell("running", "x"))).toBe("");
    expect(taskNote(shell("done", "Build the app"))).toBe("");
  });

  it("times a finished step from a second up", () => {
    expect(stepDuration(step())).toBe("");
    expect(stepDuration(step({ status: "ok", endedAt: "2026-11-03T10:00:00.400Z" }))).toBe("");
    expect(stepDuration(step({ status: "ok", endedAt: "2026-11-03T10:00:03.000Z" }))).toBe("3s");
  });
});

describe("summaries", () => {
  it("builds the Main row's second line", () => {
    expect(texts(summaryParts(3, 1_240_000))).toEqual(["3 running", "1.2M tokens"]);
    expect(texts(summaryParts(0, 900))).toEqual(["900 tokens"]);
  });

  it("summarises a collapsed section", () => {
    expect(sectionSummary(["running", "done", "running"])).toBe("2 running");
    expect(sectionSummary(["done", "failed"])).toBe("2 finished");
  });

  it("counts running agents and the background tasks that are not listed elsewhere", () => {
    const sessionTree = tree({
      workflows: [workflow([], { taskId: "wf-task" })],
      subagents: [node("bg", "running")],
      tasks: [task("wf-task", "running", { kind: "workflow" }), task("bg", "running", { kind: "agent" }), task("sh", "running")],
      counts: { total: 3, running: 2, done: 1, failed: 0 },
    });
    expect(visibleTasks(sessionTree).map((item) => item.id)).toEqual(["sh"]);
    expect(runningTotal(sessionTree, visibleTasks(sessionTree))).toBe(3);
  });

  it("lists workflows, subagents and the other tasks as one list, running first", () => {
    const sessionTree = tree({
      workflows: [workflow([], { runId: "wf_9", taskId: "wf-task", status: "done", startedAt: t(0), endedAt: t(9) })],
      subagents: [node("sub", "running", { startedAt: t(3) })],
      tasks: [task("wf-task", "done", { kind: "workflow" }), task("sh", "running", { startedAt: t(1) }), task("old", "done", { startedAt: t(0), endedAt: t(2) })],
    });
    const items = treeItems(sessionTree);
    expect(items.map((item) => item.key)).toEqual(["workflow:wf_9", "agent:sub", "task:sh", "task:old"]);
    const { shown, folded } = splitRows(items, itemTiming, hasLive(items, itemTiming));
    expect(shown.map((item) => item.key)).toEqual(["task:sh", "agent:sub"]);
    expect(folded.map((item) => item.key)).toEqual(["workflow:wf_9", "task:old"]);
  });
});

describe("workflows", () => {
  it("says how far a run is while it runs, stalled agents in words, and its totals after", () => {
    const counts = { total: 10, running: 3, done: 6, failed: 1 };
    const tokens = { input: 0, output: 0, cacheRead: 1_240_000, cacheWrite: 0 };
    expect(workflowParts(workflow([], { agentCounts: counts, tokens }), ["running", "stalled", "stalled", "done"])).toEqual([
      { text: "6/10 agents", tone: "muted" },
      { text: "1 failed", tone: "danger" },
      { text: "2 stalled", tone: "warning" },
      { text: "1.2M tokens", tone: "muted" },
    ]);
    const finished = workflowParts(workflow([], { status: "done", agentCounts: counts, tokens, endedAt: "2026-11-03T10:12:00.000Z" }), ["done"]);
    expect(texts(finished)).toEqual(["10 agents", "1 failed", "1.2M tokens"]);
    expect(workflowParts(workflow([]), [])).toEqual([{ text: "Waiting for agents to start", tone: "muted" }]);
  });

  it("draws one cell per agent, stalled after 90 s without activity", () => {
    const now = Date.parse("2026-11-03T10:05:00.000Z");
    expect(cellState(node("a", "running", { lastActivityAt: "2026-11-03T10:04:30.000Z" }), now)).toBe("running");
    expect(cellState(node("a", "running", { lastActivityAt: "2026-11-03T10:03:00.000Z" }), now)).toBe("stalled");
    expect(cellState(node("a", "unknown"), now)).toBe("pending");
    const run = workflow([
      { title: "Scan", detail: null, status: "done", agents: [node("a", "done"), node("b", "failed")] },
      { title: "Fix", detail: null, status: "running", agents: [node("c", "running", { lastActivityAt: "2026-11-03T10:04:59.000Z" })] },
    ]);
    const cells = workflowCells(run, now);
    expect(cells).toEqual(["done", "failed", "running"]);
    expect(cellsSummary(cells)).toBe("1 of 3 agents done, 1 running, 0 stalled, 1 failed");
  });

  it("heads phases only when there are several, and says why one is empty", () => {
    const phase = (title: string, status: RunStatus, agents: AgentNode[]): Phase => ({ title, detail: null, status, agents });
    expect(phaseHeading(phase("Scan", "done", []), 1)).toBeNull();
    expect(phaseHeading(phase("Scan", "done", []), 2)).toBe("Scan");
    expect(phaseHeading(phase("(no phase)", "done", []), 2)).toBe("Other agents");
    expect(phaseProgress(phase("Scan", "running", [node("a", "done"), node("b", "running")]))).toEqual({ short: "1/2", sentence: "1 of 2 done" });
    expect(phaseProgress(phase("Fix", "pending", [])).sentence).toBe("No agents have started yet");
    expect(phaseProgress(phase("Fix", "unknown", [])).short).toBe("Not run");
  });
});

describe("sameNode", () => {
  it("sees a poll's fresh copy of an unchanged node as the same, and any change as different", () => {
    const original = node("a", "running", { currentStep: step(), tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
    const copy: AgentNode = JSON.parse(JSON.stringify(original));
    expect(sameNode(original, copy)).toBe(true);
    expect(sameNode(original, { ...copy, toolCalls: 1 })).toBe(false);
    expect(sameNode(original, { ...copy, tokens: { ...copy.tokens, output: 3 } })).toBe(false);
    expect(sameNode(original, { ...copy, currentStep: step({ title: "Other" }) })).toBe(false);
    expect(sameNode(original, { ...copy, currentStep: null })).toBe(false);
  });
});
