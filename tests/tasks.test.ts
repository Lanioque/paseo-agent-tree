import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assistant, claudeRecord, fixtureNow, jsonl, notification, queueOperation, sandbox, toolResult, toolUse, treeOf, userPrompt } from "./fixtures";

const CWD = "/work/shells";
const SESSION = "33333333-4444-5555-6666-777777777777";
const AGENT = "paseo-agent-shell";
const HOUR = 3_600_000;

describe("background tasks", () => {
  it("tracks background shells through launch, notification, TaskStop and output-file activity", async () => {
    const box = sandbox();
    try {
      box.record(claudeRecord(AGENT, CWD, SESSION));
      const liveOutput = box.write(join(box.root, "tmp", "bmv2.output"), "still printing");
      const liveBackground = box.write(join(box.root, "tmp", "blive5.output"), "listening on :3000");
      const done = queueOperation(notification("bsh1", "t_done", "completed", 'Background command "Build the app" completed (exit code 0)'));
      // The same block delivered again when the busy agent took it, 20 minutes after the build ended.
      const delivered = { ...userPrompt(notification("bsh1", "t_done", "completed", 'Background command "Build the app" completed (exit code 0)')), timestamp: new Date(Date.parse(String(done.timestamp)) + 20 * 60_000).toISOString() };
      const main = box.write(
        box.transcript(CWD, SESSION),
        jsonl([
          userPrompt("Build it"),
          ...assistant("m1", [toolUse("t_done", "Bash", { command: "npm run build", description: "Build the app", run_in_background: true })], { output: 1 }),
          toolResult("t_done", "Command running in background with ID: bsh1. Output is being written to: /tmp/none/bsh1.output. You will be notified when it completes.", { toolUseResult: { stdout: "", backgroundTaskId: "bsh1" } }),
          ...assistant("m2", [toolUse("t_moved", "Bash", { command: "npm test", description: "Run the tests", timeout: 120000 })], { output: 1 }),
          toolResult("t_moved", `Command did not complete within its 120s timeout and was moved to the background (ID: bmv2). Output is being written to: ${liveOutput}. If it exits while you are still working you will be notified.`),
          ...assistant("m2b", [toolUse("t_live", "Bash", { command: "npm run dev", description: "Dev server", run_in_background: true })], { output: 1 }),
          toolResult("t_live", `Command running in background with ID: blive5. Output is being written to: ${liveBackground}.`, { toolUseResult: { stdout: "", backgroundTaskId: "blive5" } }),
          ...assistant("m3", [toolUse("t_stop", "Bash", { command: "npm run dev", run_in_background: true })], { output: 1 }),
          toolResult("t_stop", "Command running in background with ID: bst3. Output is being written to: /tmp/none/bst3.output"),
          ...assistant("m4", [toolUse("t_kill", "TaskStop", { task_id: "bst3" })], { output: 1 }),
          toolResult("t_kill", '{"message":"Successfully stopped task: bst3"}', { toolUseResult: { message: "stopped", task_id: "bst3", task_type: "local_bash" } }),
          ...assistant("m5", [toolUse("t_old", "Bash", { command: "sleep 9999", description: "Wait", run_in_background: true })], { output: 1 }),
          toolResult("t_old", "Command running in background with ID: bold4. Output is being written to: /tmp/none/bold4.output"),
          ...assistant("m6", [toolUse("t_echo", "Bash", { command: "cat log.txt" })], { output: 1 }),
          toolResult("t_echo", "line one\nCommand running in background with ID: fake9. Output is being written to: /x"),
          done,
          queueOperation(notification("orphan1", "toolu_gone", "failed", 'Background command "lost" failed with exit code 1')),
          delivered,
        ]),
      );
      const now = fixtureNow() + 2 * HOUR;
      box.age(main, 2 * HOUR, now);
      box.age(liveOutput, 60_000, now);
      box.age(liveBackground, 5 * 60_000, now);
      const tree = await treeOf(box, AGENT, () => now);
      const byId = new Map(tree.tasks.map((task) => [task.id, task]));
      expect([...byId.keys()].sort()).toEqual(["blive5", "bmv2", "bold4", "bsh1", "bst3", "orphan1"]);
      expect(byId.get("bsh1")).toMatchObject({ kind: "shell", title: "Build the app", status: "done", summary: 'Background command "Build the app" completed (exit code 0)' });
      expect(byId.get("bsh1")?.endedAt).toBe(done.timestamp);
      // Both of Claude Code's sentences end with a period right after the output path.
      expect(byId.get("bmv2")).toMatchObject({ kind: "shell", title: "Run the tests", status: "running", endedAt: null });
      expect(byId.get("blive5")).toMatchObject({ title: "Dev server", status: "running" });
      expect(byId.get("bst3")).toMatchObject({ title: "npm run dev", status: "stopped" });
      expect(byId.get("bst3")?.endedAt).not.toBeNull();
      expect(byId.get("bold4")).toMatchObject({ title: "Wait", status: "stopped" });
      expect(byId.get("orphan1")).toMatchObject({ kind: "shell", status: "failed", title: 'Background command "lost" failed with exit code 1', startedAt: null });
      const started = tree.tasks.map((task) => task.startedAt).filter((value): value is string => value !== null);
      expect(started).toEqual([...started].sort().reverse());
    } finally {
      box.cleanup();
    }
  });

  it("keeps a quiet shell running while the agent that started it runs", async () => {
    const box = sandbox();
    try {
      const main = box.write(
        box.transcript(CWD, SESSION),
        jsonl([
          userPrompt("Serve it"),
          ...assistant("m1", [toolUse("t_srv", "Bash", { command: "pnpm dev", description: "Dev server", run_in_background: true })], { output: 1 }),
          toolResult("t_srv", "Command running in background with ID: bsrv1. Output is being written to: /tmp/none/bsrv1.output."),
          ...assistant("m2", [toolUse("t_slow", "Bash", { command: "pnpm test", description: "Slow tests" })], { output: 1 }),
          toolResult("t_slow", "Command did not complete within its 120s timeout and was moved to the background (ID: bslow2). Output is being written to: /tmp/none/bslow2.output."),
        ]),
      );
      const now = fixtureNow() + 2 * HOUR;
      box.age(main, 2 * HOUR, now);
      const statuses = async () => new Map((await treeOf(box, AGENT, () => now)).tasks.map((task) => [task.id, task.status]));
      box.record(claudeRecord(AGENT, CWD, SESSION, { lastStatus: "running" }));
      // The timed-out command was killed with the turn that moved it to the background.
      expect(await statuses()).toEqual(new Map([["bsrv1", "running"], ["bslow2", "stopped"]]));
      box.record(claudeRecord(AGENT, CWD, SESSION, { lastStatus: "idle" }));
      expect(await statuses()).toEqual(new Map([["bsrv1", "stopped"], ["bslow2", "stopped"]]));
    } finally {
      box.cleanup();
    }
  });
});
