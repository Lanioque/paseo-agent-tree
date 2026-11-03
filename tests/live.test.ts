import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentStepsSchema, runsOverviewRpc, sessionTreeSchema } from "../shared/contract";
import { defaultEnv } from "../server/env";
import { createHandlers } from "../server/rpc";
import { SessionStore } from "../server/session";

// Runs the three RPCs read-only against a real Paseo agent on this machine. Skipped unless
// AGENT_TREE_LIVE_AGENT_ID names a Claude Code agent; AGENT_TREE_LIVE_RUN_ID adds the checks of one of its
// workflow runs (wf_…). Example: AGENT_TREE_LIVE_AGENT_ID=<id> AGENT_TREE_LIVE_RUN_ID=wf_… npm test

const AGENT_ID = process.env.AGENT_TREE_LIVE_AGENT_ID ?? "";
const RUN_ID = process.env.AGENT_TREE_LIVE_RUN_ID ?? "";
const env = defaultEnv();

/** Distinct journal keys started so far (a retry or a resume reuses its key): the row count the tree must show. */
function journalKeys(journal: string): number {
  const keys = new Set<string>();
  for (const line of readFileSync(journal, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { type?: string; key?: string; agentId?: string };
    if (entry.type === "started") keys.add(entry.key ?? entry.agentId ?? "");
  }
  return keys.size;
}

/** journal.jsonl of a workflow run: <claude dir>/projects/<projDir>/<sessionId>/subagents/workflows/<runId>/. */
function findJournal(sessionId: string, runId: string): string | null {
  for (const dir of env.claudeDirs) {
    const projects = join(dir, "projects");
    if (!existsSync(projects)) continue;
    for (const project of readdirSync(projects)) {
      const path = join(projects, project, sessionId, "subagents", "workflows", runId, "journal.jsonl");
      if (existsSync(path)) return path;
    }
  }
  return null;
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await work();
  return { value, ms: Math.round((performance.now() - start) * 10) / 10 };
}

describe.skipIf(AGENT_ID === "")("live session", () => {
  it("builds the tree, the step lists and the overview from the real files", async () => {
    const handlers = createHandlers(new SessionStore(env));
    const cold = await timed(() => handlers.tree({ agentId: AGENT_ID }));
    const warm = await timed(() => handlers.tree({ agentId: AGENT_ID }));
    const tree = sessionTreeSchema.parse(warm.value);
    sessionTreeSchema.parse(cold.value);
    expect(tree.found).toBe(true);
    expect(tree.sessionId).not.toBeNull();

    const mainSteps = agentStepsSchema.parse(await handlers.steps({ agentId: AGENT_ID, childId: "main", runId: null, limit: 1000 }));
    expect(mainSteps.found).toBe(true);
    expect(mainSteps.steps.length).toBeGreaterThan(0);

    const workflow = RUN_ID ? tree.workflows.find((entry) => entry.runId === RUN_ID) : undefined;
    if (RUN_ID) {
      expect(workflow).toBeDefined();
      if (!workflow) return;
      const agents = workflow.phases.flatMap((phase) => phase.agents);
      const journal = tree.sessionId ? findJournal(tree.sessionId, RUN_ID) : null;
      expect(journal).not.toBeNull();
      if (journal) expect(agents.length).toBe(journalKeys(journal));
      expect(workflow.agentCounts.total).toBe(agents.length);
      expect(tree.totalTokens.output).toBeGreaterThanOrEqual(workflow.tokens.output + (tree.main?.tokens.output ?? 0));
      const agent = agents[0];
      if (agent) {
        const steps = agentStepsSchema.parse(await handlers.steps({ agentId: AGENT_ID, childId: agent.id, runId: RUN_ID, limit: 200 }));
        expect(steps.found).toBe(true);
        expect(steps.node?.id).toBe(agent.id);
        expect(steps.prompt).not.toBeNull();
      }
      // The Workflow call is among the steps until the session outgrows the step cap.
      if (!mainSteps.truncated) expect(mainSteps.steps.some((step) => step.tool === "Workflow")).toBe(true);
    }

    const overviewCold = await timed(() => handlers.overview({ sinceHours: 24 }));
    const overviewWarm = await timed(() => handlers.overview({ sinceHours: 24 }));
    const overview = runsOverviewRpc.output.parse(overviewWarm.value);
    expect(overview.sessions.length).toBeLessThanOrEqual(40);

    console.log(
      JSON.stringify({
        treeColdMs: cold.ms,
        treeWarmMs: warm.ms,
        overviewColdMs: overviewCold.ms,
        overviewWarmMs: overviewWarm.ms,
        overviewSessions: overview.sessions.length,
        heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
        workflows: tree.workflows.map((entry) => ({ runId: entry.runId, name: entry.name, status: entry.status, phases: entry.phases.map((phase) => `${phase.title}:${phase.status}:${phase.agents.length}`), counts: entry.agentCounts })),
        subagents: tree.subagents.length,
        tasks: tree.tasks.map((task) => `${task.kind}:${task.status}`),
        counts: tree.counts,
        totalTokens: tree.totalTokens,
      }),
    );
    expect(warm.ms).toBeLessThan(150);
  }, 60_000);
});
