import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentStepsSchema } from "../shared/contract";
import {
  assistant,
  claudeRecord,
  fixtureNow,
  handlersFor,
  jsonl,
  notification,
  queueOperation,
  sandbox,
  text,
  toolResult,
  toolUse,
  treeOf,
  userPrompt,
  type Sandbox,
} from "./fixtures";

const CWD = "/work/repo";
const SESSION = "11111111-2222-3333-4444-555555555555";
const AGENT = "paseo-agent-wf";
const RUN = "wf_aaaa1111-001";
const HOUR = 3_600_000;

const SCRIPT = `export const meta = {
  name: 'ci-audit',
  description: 'Audit the CI',
  phases: [
    { title: 'Audit', detail: 'parallel audits' },
    { title: 'Bench', detail: 'sequential benches' },
    { title: 'Critic', detail: 'one critic' },
  ],
}
export default async function run() {}`;

interface Built {
  box: Sandbox;
  files: string[];
  mainPath: string;
}

function build(extraMain: ReturnType<typeof queueOperation>[] = []): Built {
  const box = sandbox();
  box.record(claudeRecord(AGENT, CWD, SESSION));
  const dir = join(box.sessionDir(CWD, SESSION), "subagents", "workflows", RUN);
  const mainPath = box.write(
    box.transcript(CWD, SESSION),
    jsonl([
      userPrompt("Run the audit"),
      ...assistant("m1", [toolUse("toolu_wf", "Workflow", { script: SCRIPT })], { input: 4, output: 10, cacheRead: 100 }),
      toolResult("toolu_wf", `Workflow launched in background. Task ID: wtask1\nRun ID: ${RUN}\nTranscript dir: ${dir}`, {
        toolUseResult: { status: "async_launched", taskId: "wtask1", runId: RUN, transcriptDir: dir, workflowName: "ci-audit" },
      }),
      ...assistant("m2", [text("Started the audit.")], { input: 1, output: 5 }, { stop: "end_turn" }),
      ...extraMain,
    ]),
  );
  const journal = box.write(
    join(dir, "journal.jsonl"),
    jsonl([
      { type: "launched" },
      { type: "started", key: "k-b1", agentId: "b1", label: "bench:typecheck", phase: "Bench" },
      { type: "started", key: "k-a1", agentId: "a1", label: "audit:history", phase: "Audit" },
      { type: "started", key: "k-a2", agentId: "a2", label: "audit:runners", phase: "Audit" },
      { type: "started", key: "k-r1", agentId: "r1", label: "report", phase: "Report" },
      { type: "started", key: "k-n1", agentId: "n1", label: "loose" },
      { type: "started", key: "k-a1", agentId: "a1", label: "audit:history", phase: "Audit" },
      { type: "result", key: "k-a1", agentId: "a1", result: { summary: "history is fine", measurements: [] } },
      { type: "failed", key: "k-a2", agentId: "a2" },
      { type: "result", key: "k-r1", result: "report text" },
      { type: "result", key: "k-n1", agentId: "n1", result: null },
      { type: "checkpoint", note: "unknown types are ignored" },
    ]),
  );
  const files = [mainPath, journal];
  const agent = (id: string, phase: string, output: number, finished: boolean) => {
    box.write(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", description: id, workflowPhase: phase, spawnDepth: 1, requestShape: "foreground" }));
    const lines = [
      userPrompt(`Task for ${id}`, { isSidechain: true, agentId: id }),
      ...assistant(`${id}-m1`, [toolUse(`${id}-t1`, "Bash", { command: "ls", description: `List for ${id}` })], { input: 2, output, cacheRead: 50, cacheWrite: 10 }),
      toolResult(`${id}-t1`, "listing"),
      ...(finished ? assistant(`${id}-m2`, [text(`${id} final words`), toolUse(`${id}-so`, "StructuredOutput", { summary: "x" })], { input: 1, output: 1 }) : assistant(`${id}-m2`, [toolUse(`${id}-t2`, "Read", { file_path: "/work/repo/a.ts" })], { input: 1, output: 1 })),
    ];
    files.push(box.write(join(dir, `agent-${id}.jsonl`), jsonl(lines)));
  };
  agent("a1", "Audit", 30, true);
  agent("a2", "Audit", 20, true);
  agent("b1", "Bench", 40, false);
  agent("r1", "Report", 5, true);
  return { box, files, mainPath };
}

describe("workflow runs", () => {
  it("builds phases from meta then journal, with pending, failed and running phases", async () => {
    const { box } = build();
    try {
      const tree = await treeOf(box, AGENT);
      expect(tree.found).toBe(true);
      expect(tree.workflows).toHaveLength(1);
      const workflow = tree.workflows[0];
      if (!workflow) return;
      expect(workflow).toMatchObject({ runId: RUN, taskId: "wtask1", name: "ci-audit", description: "Audit the CI", status: "running", endedAt: null });
      expect(workflow.phases.map((phase) => [phase.title, phase.status, phase.agents.map((agent) => agent.id)])).toEqual([
        ["Audit", "failed", ["a1", "a2"]],
        ["Bench", "running", ["b1"]],
        ["Critic", "pending", []],
        ["Report", "done", ["r1"]],
        ["(no phase)", "failed", ["n1"]],
      ]);
      expect(workflow.phases[0]?.detail).toBe("parallel audits");
      const [a1, a2] = workflow.phases[0]?.agents ?? [];
      expect(a1).toMatchObject({ kind: "workflow-agent", label: "audit:history", status: "done", resultPreview: "history is fine", phase: "Audit", turns: 2, toolCalls: 2 });
      // The closing StructuredOutput never gets a tool_result; once the agent is done it is not shown as running.
      expect(a1?.currentStep).toMatchObject({ tool: "StructuredOutput", status: "ok" });
      // tree.get carries only the headline of each current step; agent.steps has its input and result.
      expect(a1?.currentStep).toMatchObject({ detail: null, resultPreview: null });
      expect(a1?.tokens).toEqual({ input: 3, output: 31, cacheRead: 50, cacheWrite: 10 });
      // Failed through its journal "failed" line although its transcript was written a moment ago.
      expect(a2).toMatchObject({ status: "failed", resultPreview: null });
      expect(workflow.phases[4]?.agents[0]?.status).toBe("failed");
      const b1 = workflow.phases[1]?.agents[0];
      expect(b1).toMatchObject({ status: "running", endedAt: null });
      expect(b1?.currentStep).toMatchObject({ tool: "Read", status: "running" });
      expect(workflow.agentCounts).toEqual({ total: 5, running: 1, done: 2, failed: 2 });
      expect(workflow.tokens.output).toBe(31 + 21 + 41 + 6);
      expect(tree.totalTokens.output).toBe(15 + workflow.tokens.output);
      expect(tree.counts).toEqual(workflow.agentCounts);
      expect(tree.tasks).toEqual([expect.objectContaining({ id: "wtask1", kind: "workflow", status: "running", title: "ci-audit" })]);
      expect(tree.main?.currentStep).toMatchObject({ kind: "text", title: "Started the audit." });
    } finally {
      box.cleanup();
    }
  });

  it("stops agents and the run after STALE_MS without activity", async () => {
    const { box, files } = build();
    try {
      const now = fixtureNow() + 3 * HOUR;
      for (const file of files) box.age(file, 3 * HOUR, now);
      const workflow = (await treeOf(box, AGENT, () => now)).workflows[0];
      expect(workflow?.status).toBe("stopped");
      expect(workflow?.endedAt).not.toBeNull();
      expect(workflow?.phases.map((phase) => phase.status)).toEqual(["failed", "stopped", "stopped", "done", "failed"]);
    } finally {
      box.cleanup();
    }
  });

  it("ends the run on its task notification and stops agents left without a result", async () => {
    const { box } = build([queueOperation(notification("wtask1", "toolu_wf", "completed", 'Dynamic workflow "Audit the CI" completed', '{"verdict":"ok"}'))]);
    try {
      const workflow = (await treeOf(box, AGENT)).workflows[0];
      expect(workflow).toMatchObject({ status: "done", resultPreview: '{"verdict":"ok"}' });
      expect(workflow?.endedAt).not.toBeNull();
      expect(workflow?.phases[1]?.agents[0]?.status).toBe("stopped");
      // Critic never ran in a run that completed: skipped, not an incident.
      expect(workflow?.phases[2]).toMatchObject({ title: "Critic", status: "unknown", agents: [] });
    } finally {
      box.cleanup();
    }
    const killed = build([queueOperation(notification("wtask1", "toolu_wf", "killed", "Workflow stopped"))]);
    try {
      expect((await treeOf(killed.box, AGENT)).workflows[0]?.status).toBe("stopped");
    } finally {
      killed.box.cleanup();
    }
  });

  it("lists a workflow agent's steps with its prompt and final result", async () => {
    const { box } = build();
    try {
      const handlers = handlersFor(box);
      const steps = agentStepsSchema.parse(await handlers.steps({ agentId: AGENT, childId: "a1", runId: RUN, limit: 2 }));
      expect(steps.found).toBe(true);
      expect(steps.node?.id).toBe("a1");
      expect(steps.prompt).toBe("Task for a1");
      expect(steps.truncated).toBe(true);
      expect(steps.steps.map((step) => step.title)).toEqual(["a1 final words", "Returned result"]);
      expect(steps.finalText).toBe("history is fine");
      expect(steps.node?.currentStep?.detail).toContain('"summary": "x"');
      const running = agentStepsSchema.parse(await handlers.steps({ agentId: AGENT, childId: "b1", runId: RUN, limit: 50 }));
      expect(running.finalText).toBeNull();
      expect(running.truncated).toBe(false);
      expect(running.steps.map((step) => step.status)).toEqual(["ok", "running"]);
      const missing = agentStepsSchema.parse(await handlers.steps({ agentId: AGENT, childId: "../../etc", runId: RUN, limit: 5 }));
      expect(missing).toMatchObject({ found: false, node: null, steps: [] });
      const main = agentStepsSchema.parse(await handlers.steps({ agentId: AGENT, childId: "main", runId: null, limit: 10 }));
      expect(main.prompt).toBe("Run the audit");
      expect(main.finalText).toBe("Started the audit.");
      expect(main.steps.map((step) => step.tool)).toEqual(["Workflow", null]);
      expect(main.steps[0]?.title).toBe("ci-audit");
    } finally {
      box.cleanup();
    }
  });

  it("shows one row per journal key: the latest attempt, with the work of the earlier ones in its counters", async () => {
    const box = sandbox();
    try {
      box.record(claudeRecord(AGENT, CWD, SESSION));
      box.write(box.transcript(CWD, SESSION), jsonl([userPrompt("hi")]));
      const dir = join(box.sessionDir(CWD, SESSION), "subagents", "workflows", RUN);
      box.write(
        join(dir, "journal.jsonl"),
        jsonl([
          { type: "launched" },
          { type: "started", key: "k-retry", agentId: "x1", label: "build:oauth", phase: "Build" },
          { type: "started", key: "k-resume", agentId: "y1", label: "build:api", phase: "Build" },
          { type: "failed", key: "k-retry", agentId: "x1" },
          { type: "started", key: "k-retry", agentId: "x2", label: "build:oauth", phase: "Build" },
          { type: "result", key: "k-retry", agentId: "x2", result: "oauth built" },
          // Resumed after a crash: the same key under a new id, the first attempt never ended.
          { type: "started", key: "k-resume", agentId: "y2", label: "build:api", phase: "Build" },
          { type: "started", key: "k-resume", agentId: "y2", label: "build:api", phase: "Build" },
        ]),
      );
      for (const [id, output] of [["x1", 10], ["x2", 20], ["y1", 40], ["y2", 80]] as const) {
        box.write(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", description: "build", workflowPhase: "Build", spawnDepth: 1 }));
        box.write(join(dir, `agent-${id}.jsonl`), jsonl([userPrompt(`Task ${id}`), ...assistant(`${id}-m`, [toolUse(`${id}-t`, "Read", { file_path: "/work/repo/a.ts" })], { input: 1, output })]));
      }
      const tree = await treeOf(box, AGENT);
      const workflow = tree.workflows[0];
      expect(workflow?.phases.map((phase) => [phase.title, phase.status, phase.agents.map((agent) => [agent.id, agent.status])])).toEqual([
        ["Build", "running", [["x2", "done"], ["y2", "running"]]],
      ]);
      const [x2, y2] = workflow?.phases[0]?.agents ?? [];
      expect(x2).toMatchObject({ label: "build:oauth", resultPreview: "oauth built", turns: 2, toolCalls: 2, tokens: { input: 2, output: 30, cacheRead: 0, cacheWrite: 0 } });
      expect(y2?.tokens.output).toBe(120);
      expect(workflow?.agentCounts).toEqual({ total: 2, running: 1, done: 1, failed: 0 });
      expect(workflow?.tokens.output).toBe(150);
      expect(tree.totalTokens.output).toBe(150);
      const handlers = handlersFor(box);
      const steps = agentStepsSchema.parse(await handlers.steps({ agentId: AGENT, childId: "x2", runId: RUN, limit: 10 }));
      expect(steps).toMatchObject({ found: true, prompt: "Task x2", finalText: "oauth built" });
      expect((await handlers.steps({ agentId: AGENT, childId: "x1", runId: RUN, limit: 10 })).found).toBe(false);
    } finally {
      box.cleanup();
    }
  });

  it("finds a run from its directory alone and names it from the script copy", async () => {
    const box = sandbox();
    try {
      box.record(claudeRecord(AGENT, CWD, SESSION));
      box.write(box.transcript(CWD, SESSION), jsonl([userPrompt("hi")]));
      const sessionDir = box.sessionDir(CWD, SESSION);
      box.write(join(sessionDir, "workflows", "scripts", `nightly-sweep-${RUN}.js`), "export const meta = { name: 'nightly-sweep', phases: [{ title: 'Sweep' }] }");
      box.write(join(sessionDir, "subagents", "workflows", RUN, "journal.jsonl"), jsonl([{ type: "launched" }, { type: "started", agentId: "s1", label: "sweep:a", phase: "Sweep" }]));
      const workflow = (await treeOf(box, AGENT)).workflows[0];
      expect(workflow).toMatchObject({ runId: RUN, taskId: null, name: "nightly-sweep", status: "running" });
      expect(workflow?.phases[0]?.agents[0]).toMatchObject({ id: "s1", status: "running", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, currentStep: null });
    } finally {
      box.cleanup();
    }
  });
});
