import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentStepsSchema } from "../shared/contract";
import { assistant, attachmentPrompt, claudeRecord, fixtureNow, handlersFor, jsonl, notification, queueOperation, sandbox, text, toolResult, toolUse, treeOf, userPrompt, type Line, type Sandbox } from "./fixtures";

const CWD = "/work/app";
const SESSION = "22222222-3333-4444-5555-666666666666";
const AGENT = "paseo-agent-sub";
const HOUR = 3_600_000;

const ack = (agentId: string): Line => ({ isAsync: true, status: "async_launched", agentId, description: "x", outputFile: "/tmp/x.output" });
const ackText = (agentId: string) => `Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ${agentId} (internal ID)`;

function build(): { box: Sandbox; files: string[] } {
  const box = sandbox();
  box.record(claudeRecord(AGENT, CWD, SESSION));
  const main = box.write(
    box.transcript(CWD, SESSION),
    jsonl([
      userPrompt("Review everything"),
      ...assistant("m1", [
        toolUse("toolu_fg", "Agent", { description: "Foreground review", subagent_type: "general-purpose", prompt: "Review the diff", run_in_background: false }),
      ], { output: 3 }),
      toolResult("toolu_fg", [{ type: "text", text: "All clean." }], { toolUseResult: { status: "completed", agentId: "afg", content: [{ type: "text", text: "All clean." }], totalTokens: 900 } }),
      ...assistant("m2", [
        toolUse("toolu_bg", "Agent", { description: "Background research", subagent_type: "general-purpose", prompt: "Research" }),
        toolUse("toolu_bf", "Agent", { description: "Background that fails", prompt: "Try" }),
        toolUse("toolu_run", "Agent", { description: "Still working", prompt: "Work" }),
        toolUse("toolu_nometa", "Agent", { description: "Old style agent", subagent_type: "Explore", prompt: "Explore" }),
      ], { output: 4 }),
      toolResult("toolu_bg", [{ type: "text", text: ackText("abg") }], { toolUseResult: ack("abg") }),
      toolResult("toolu_bf", [{ type: "text", text: ackText("abf") }]),
      toolResult("toolu_run", [{ type: "text", text: ackText("arun") }], { toolUseResult: ack("arun") }),
      toolResult("toolu_nometa", [{ type: "text", text: "Done exploring." }], { toolUseResult: { status: "completed", agentId: "aold", content: [{ type: "text", text: "Done exploring." }] } }),
      queueOperation(notification("abg", "toolu_bg", "completed", 'Agent "Background research" finished', "Research report")),
      attachmentPrompt(notification("abf", "toolu_bf", "failed", 'Agent "Background that fails" failed')),
    ]),
  );
  const files = [main];
  const dir = join(box.sessionDir(CWD, SESSION), "subagents");
  const child = (id: string, meta: Line | null, lines: Line[]) => {
    if (meta) box.write(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
    files.push(box.write(join(dir, `agent-${id}.jsonl`), jsonl([userPrompt(`Prompt of ${id}`, { isSidechain: true, agentId: id }), userPrompt("<system-reminder>meta</system-reminder>", { isMeta: true, isSidechain: true }), ...lines])));
  };
  const finished = (id: string) => assistant(`${id}-m`, [toolUse(`${id}-t`, "Grep", { pattern: "x" })], { input: 1, output: 10 }).concat(toolResult(`${id}-t`, "match"), assistant(`${id}-m2`, [text(`${id} says done`)], { input: 1, output: 2 }, { stop: "end_turn" }));
  child("afg", { agentType: "general-purpose", description: "Foreground review", toolUseId: "toolu_fg", spawnDepth: 1, requestShape: "foreground" }, finished("afg"));
  child("abg", { agentType: "general-purpose", description: "Background research", toolUseId: "toolu_bg", spawnDepth: 1, requestShape: "background" }, finished("abg"));
  child("abf", { agentType: "general-purpose", description: "Background that fails", toolUseId: "toolu_bf", spawnDepth: 1, requestShape: "background" }, assistant("abf-m", [text("trying")], { output: 1 }));
  child("arun", { agentType: "general-purpose", description: "Still working", toolUseId: "toolu_run", spawnDepth: 2, requestShape: "background" }, assistant("arun-m", [toolUse("arun-t", "WebFetch", { url: "https://example.com" })], { output: 1 }));
  child("aold", null, finished("aold"));
  return { box, files };
}

describe("Agent tool subagents", () => {
  it("links each file to its Agent call and reads its end from the tool result or the notification", async () => {
    const { box } = build();
    try {
      const tree = await treeOf(box, AGENT);
      const byId = new Map(tree.subagents.map((node) => [node.id, node]));
      expect(byId.get("afg")).toMatchObject({ kind: "subagent", label: "Foreground review", status: "done", background: false, resultPreview: "All clean.", agentType: "general-purpose", phase: null });
      expect(byId.get("abg")).toMatchObject({ status: "done", background: true, resultPreview: "Research report" });
      expect(byId.get("abf")).toMatchObject({ status: "failed", background: true });
      expect(byId.get("arun")).toMatchObject({ status: "running", depth: 2, endedAt: null });
      expect(byId.get("arun")?.currentStep).toMatchObject({ tool: "WebFetch", status: "running", title: "https://example.com" });
      expect(byId.get("aold")).toMatchObject({ label: "Old style agent", agentType: "Explore", status: "done", resultPreview: "Done exploring." });
      expect(tree.counts).toEqual({ total: 5, running: 1, done: 3, failed: 1 });
      expect(tree.tasks.filter((task) => task.kind === "agent").map((task) => [task.id, task.status]).sort()).toEqual([
        ["abf", "failed"],
        ["abg", "done"],
        ["arun", "running"],
      ]);
      const sum = tree.subagents.reduce((total, node) => total + node.tokens.output, 0);
      expect(tree.totalTokens.output).toBe(7 + sum);
    } finally {
      box.cleanup();
    }
  });

  it("stops a background agent that went quiet without a notification", async () => {
    const { box, files } = build();
    try {
      const now = fixtureNow() + 2 * HOUR;
      for (const file of files) box.age(file, 2 * HOUR, now);
      const tree = await treeOf(box, AGENT, () => now);
      expect(tree.subagents.find((node) => node.id === "arun")?.status).toBe("stopped");
      expect(tree.subagents.find((node) => node.id === "abg")?.status).toBe("done");
    } finally {
      box.cleanup();
    }
  });

  it("reads the report a subagent handed back instead of Claude Code's placeholder", async () => {
    const box = sandbox();
    try {
      box.record(claudeRecord(AGENT, CWD, SESSION));
      const placeholder = (id: string) => `This agent's report was delivered to you as a message from "${id}" (its SubagentHandback call). Read it there; it is not repeated here.\n`;
      box.write(
        box.transcript(CWD, SESSION),
        jsonl([
          userPrompt("Two reviews"),
          ...assistant("m1", [toolUse("toolu_fh", "Agent", { description: "Foreground handback", prompt: "Review" }), toolUse("toolu_bh", "Agent", { description: "Background handback", prompt: "Review" })], { output: 2 }),
          toolResult("toolu_fh", [{ type: "text", text: `${placeholder("afh")}agentId: afh (use SendMessage to continue)` }], {
            toolUseResult: { status: "completed", agentId: "afh", handback: "send", handbackReport: { text: "Foreground report body" }, content: [{ type: "text", text: placeholder("afh") }] },
          }),
          toolResult("toolu_bh", [{ type: "text", text: ackText("abh") }], { toolUseResult: ack("abh") }),
          queueOperation(notification("abh", "toolu_bh", "completed", 'Agent "Background handback" finished', placeholder("abh"))),
        ]),
      );
      const dir = join(box.sessionDir(CWD, SESSION), "subagents");
      for (const [id, toolUseId, shape] of [["afh", "toolu_fh", "foreground"], ["abh", "toolu_bh", "background"]] as const) {
        box.write(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "general-purpose", description: `${shape} handback`, toolUseId, spawnDepth: 1, requestShape: shape }));
        box.write(join(dir, `agent-${id}.jsonl`), jsonl([userPrompt(`Prompt of ${id}`), ...assistant(`${id}-m`, [text("Wrapping up."), toolUse(`${id}-h`, "SubagentHandback", { message: `${id} full report` })], { output: 5 }, { stop: "tool_use" })]));
      }
      const tree = await treeOf(box, AGENT);
      const byId = new Map(tree.subagents.map((node) => [node.id, node]));
      expect(byId.get("afh")).toMatchObject({ status: "done", resultPreview: "afh full report" });
      expect(byId.get("abh")).toMatchObject({ status: "done", resultPreview: "abh full report" });
      const handlers = handlersFor(box);
      expect((await handlers.steps({ agentId: AGENT, childId: "abh", runId: null, limit: 10 })).finalText).toBe("abh full report");
      // The main session's Agent step shows the report that rode along in toolUseResult.
      const main = await handlers.steps({ agentId: AGENT, childId: "main", runId: null, limit: 10 });
      expect(main.steps.find((step) => step.id === "toolu_fh")?.resultPreview).toBe("Foreground report body");
    } finally {
      box.cleanup();
    }
  });

  it("keeps an agent running while the subagent its open Agent call waits on is active", async () => {
    const box = sandbox();
    try {
      box.record(claudeRecord(AGENT, CWD, SESSION));
      const main = box.write(
        box.transcript(CWD, SESSION),
        jsonl([userPrompt("Go"), ...assistant("m1", [toolUse("toolu_par", "Agent", { description: "Parent", prompt: "Delegate" })], { output: 1 })]),
      );
      const dir = join(box.sessionDir(CWD, SESSION), "subagents");
      box.write(join(dir, "agent-apar.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Parent", toolUseId: "toolu_par", spawnDepth: 1, requestShape: "foreground" }));
      const parent = box.write(join(dir, "agent-apar.jsonl"), jsonl([userPrompt("Delegate"), ...assistant("apar-m", [toolUse("toolu_nest", "Agent", { description: "Nested", prompt: "Dig" })], { output: 1 })]));
      box.write(join(dir, "agent-anest.meta.json"), JSON.stringify({ agentType: "Explore", description: "Nested", toolUseId: "toolu_nest", spawnDepth: 2, requestShape: "foreground" }));
      const nested = box.write(join(dir, "agent-anest.jsonl"), jsonl([userPrompt("Dig"), ...assistant("anest-m", [toolUse("anest-t", "Grep", { pattern: "x" })], { output: 1 })]));
      const now = fixtureNow() + 2 * HOUR;
      box.age(main, 2 * HOUR, now);
      box.age(parent, 2 * HOUR, now);
      box.age(nested, 60_000, now);
      const status = async () => new Map((await treeOf(box, AGENT, () => now)).subagents.map((node) => [node.id, node.status]));
      expect(await status()).toEqual(new Map([["apar", "running"], ["anest", "running"]]));
      box.age(nested, 2 * HOUR, now);
      expect(await status()).toEqual(new Map([["apar", "stopped"], ["anest", "stopped"]]));
    } finally {
      box.cleanup();
    }
  });

  it("returns a subagent's prompt, steps and final text", async () => {
    const { box } = build();
    try {
      const steps = agentStepsSchema.parse(await handlersFor(box).steps({ agentId: AGENT, childId: "afg", runId: null, limit: 10 }));
      expect(steps).toMatchObject({ found: true, prompt: "Prompt of afg", finalText: "All clean.", truncated: false });
      expect(steps.steps.map((step) => [step.kind, step.status])).toEqual([
        ["tool", "ok"],
        ["text", "ok"],
      ]);
      const running = agentStepsSchema.parse(await handlersFor(box).steps({ agentId: AGENT, childId: "arun", runId: null, limit: 10 }));
      expect(running.finalText).toBeNull();
      expect(running.node?.status).toBe("running");
    } finally {
      box.cleanup();
    }
  });
});
