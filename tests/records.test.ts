import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runsOverviewRpc } from "../shared/contract";
import { defaultEnv, projectDirName } from "../server/env";
import { assistant, claudeRecord, fixtureNow, handlersFor, jsonl, sandbox, text, treeOf, userPrompt } from "./fixtures";

const HOUR = 3_600_000;

describe("Paseo record to Claude session", () => {
  it("names project directories like Claude Code", () => {
    expect(projectDirName("/Users/me/Documents/my-repo")).toBe("-Users-me-Documents-my-repo");
    expect(projectDirName("/Users/x/repo/.claude/worktrees/brave-curie-000000")).toBe("-Users-x-repo--claude-worktrees-brave-curie-000000");
    expect(projectDirName("/Users/x/My Notes")).toBe("-Users-x-My-Notes");
  });

  it("reads PASEO_HOME and CLAUDE_CONFIG_DIR", () => {
    expect(defaultEnv({ PASEO_HOME: "~/custom-paseo", CLAUDE_CONFIG_DIR: "/opt/claude" }, "/Users/me")).toEqual({
      home: "/Users/me",
      paseoHome: "/Users/me/custom-paseo",
      claudeDirs: ["/opt/claude", "/Users/me/.claude", "/Users/me/.config/claude"],
    });
    expect(defaultEnv({ PASEO_HOME: "relative/path" }, "/Users/me").paseoHome).toBe("/Users/me/.paseo");
  });

  it("resolves the session from persistence first, then runtimeInfo, and finds moved transcripts", async () => {
    const box = sandbox();
    try {
      box.record({ ...claudeRecord("agent-a", "/work/a", "sess-persist"), runtimeInfo: { sessionId: "sess-runtime", model: "claude-opus-5-5" } });
      box.write(box.transcript("/work/a", "sess-persist"), jsonl(assistant("m1", [text("from persistence")], { output: 2 })));
      box.write(box.transcript("/work/a", "sess-runtime"), jsonl(assistant("m1", [text("from runtime")], { output: 9 })));
      const a = await treeOf(box, "agent-a");
      expect(a).toMatchObject({ found: true, sessionId: "sess-persist", cwd: "/work/a", model: "claude-opus-5-5" });
      expect(a.main?.tokens.output).toBe(2);

      box.record({ id: "agent-b", provider: "claude", cwd: "/work/b", runtimeInfo: { sessionId: "sess-b" } });
      // Stored under another project directory (cwd renamed since): found by the fallback scan.
      box.write(box.transcript("/elsewhere", "sess-b"), jsonl([userPrompt("hello")]));
      expect(await treeOf(box, "agent-b")).toMatchObject({ found: true, sessionId: "sess-b", reason: null });
    } finally {
      box.cleanup();
    }
  });

  it("explains why there is no tree", async () => {
    const box = sandbox();
    try {
      box.record({ id: "agent-codex", provider: "codex", cwd: "/work/c", persistence: { provider: "codex", sessionId: "s1" } });
      box.record({ id: "agent-new", provider: "claude", cwd: "/work/n" });
      box.record(claudeRecord("agent-gone", "/work/g", "sess-gone"));
      const codex = await treeOf(box, "agent-codex");
      expect(codex).toMatchObject({ found: false, sessionId: null, main: null, workflows: [], cwd: "/work/c" });
      expect(codex.reason).toContain("codex");
      expect((await treeOf(box, "agent-new")).reason).toBe("The agent has no Claude Code session yet.");
      expect((await treeOf(box, "agent-gone")).reason).toContain("sess-gone.jsonl was not found");
      expect((await treeOf(box, "agent-missing")).reason).toContain("No Paseo agent record");
      expect((await treeOf(box, "../../etc/passwd")).found).toBe(false);
      const steps = await handlersFor(box).steps({ agentId: "agent-codex", childId: "main", runId: null, limit: 10 });
      expect(steps).toEqual({ found: false, node: null, steps: [], truncated: false, finalText: null, prompt: null });
    } finally {
      box.cleanup();
    }
  });
});

describe("runs.overview", () => {
  it("summarises recent Claude agents, most recent first, within the window and the cap", async () => {
    const box = sandbox();
    try {
      const now = fixtureNow();
      const iso = (ago: number) => new Date(now - ago).toISOString();
      box.record(claudeRecord("recent", "/work/r", "sess-r", { lastActivityAt: iso(HOUR), title: "Recent agent" }));
      box.write(box.transcript("/work/r", "sess-r"), jsonl(assistant("m1", [text("hi")], { input: 5, output: 7 })));
      box.record(claudeRecord("newest", "/work/n", "sess-missing", { lastActivityAt: iso(60_000) }));
      box.record(claudeRecord("old", "/work/o", "sess-o", { lastActivityAt: iso(30 * HOUR) }));
      box.record({ id: "codex", provider: "codex", cwd: "/work/c", lastActivityAt: iso(HOUR) });
      box.write(join(box.env.paseoHome, "agents", "broken", "bad.json"), "{ not json");
      const overview = runsOverviewRpc.output.parse(await handlersFor(box, () => now).overview({ sinceHours: 24 }));
      // "recent" was last touched by Paseo an hour ago, but its transcript has just been written to: it sorts first.
      expect(overview.sessions.map((session) => session.agentId)).toEqual(["recent", "newest"]);
      expect(Date.parse(overview.sessions[0]?.lastActivityAt ?? "")).toBeGreaterThan(now - 60_000);
      expect(overview.sessions[0]).toMatchObject({ title: "Recent agent", cwd: "/work/r", workspaceId: "wks_test", paseoStatus: "idle", workflowsRunning: 0, tasksRunning: 0, totalTokens: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 } });
      expect(overview.sessions[1]).toMatchObject({ agentId: "newest", lastActivityAt: iso(60_000), counts: { total: 0, running: 0, done: 0, failed: 0 } });

      for (let index = 0; index < 45; index += 1) box.record(claudeRecord(`bulk-${index}`, "/work/bulk", `sess-bulk-${index}`, { lastActivityAt: iso(index * 1000) }));
      const capped = runsOverviewRpc.output.parse(await handlersFor(box, () => now).overview({ sinceHours: 24 }));
      expect(capped.sessions).toHaveLength(40);
      expect(capped.sessions[0]?.agentId).toBe("bulk-0");
    } finally {
      box.cleanup();
    }
  });
});
