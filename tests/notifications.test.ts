import { describe, expect, it } from "vitest";
import { JsonlCache } from "../server/jsonl";
import { parseNotifications, terminalStatus } from "../server/notifications";
import { transcriptReducer } from "../server/transcript";
import { attachmentPrompt, jsonl, notification, queueOperation, sandbox, userPrompt } from "./fixtures";

describe("task notifications", () => {
  it("parses every block of a text", () => {
    const text = `<system-reminder>\n${notification("b1", "toolu_1", "completed", 'Background command "x" completed (exit code 0)')}\n</system-reminder>\n${notification("w1", "toolu_2", "failed", "Dynamic workflow failed", '{"ok":false}')}`;
    expect(parseNotifications(text)).toEqual([
      { taskId: "b1", toolUseId: "toolu_1", status: "completed", summary: 'Background command "x" completed (exit code 0)', result: null },
      { taskId: "w1", toolUseId: "toolu_2", status: "failed", summary: "Dynamic workflow failed", result: '{"ok":false}' },
    ]);
    expect(parseNotifications("no notification here")).toEqual([]);
    expect(parseNotifications("<task-notification><task-id>x</task-id></task-notification>")).toEqual([]);
    expect(parseNotifications("<task-notification><task-id>ID</task-id><status>completed|failed|killed|…</status></task-notification>")).toEqual([]);
  });

  it("keeps a block quoted inside a result whole, and reads past an opening tag that is never closed", () => {
    const quoted = notification("inner1", "toolu_in", "completed", "Quoted example");
    const outer = notification("w2", "toolu_w2", "completed", "Workflow done", `The format is:\n${quoted}\nend of report`);
    expect(parseNotifications(outer)).toEqual([
      { taskId: "w2", toolUseId: "toolu_w2", status: "completed", summary: "Workflow done", result: `The format is:\n${quoted}\nend of report` },
    ]);
    const stray = `Prompt text quoting <task-notification> alone.\n${notification("b9", "toolu_9", "completed", "Real one")}`;
    expect(parseNotifications(stray).map((note) => note.taskId)).toEqual(["b9"]);
    const loneInResult = notification("w3", "toolu_w3", "completed", "Workflow done", "Parse every <task-notification> block.");
    expect(parseNotifications(`${loneInResult}\n${notification("b10", "toolu_10", "failed", "Next one")}`)).toEqual([
      { taskId: "w3", toolUseId: "toolu_w3", status: "completed", summary: "Workflow done", result: "Parse every <task-notification> block." },
      { taskId: "b10", toolUseId: "toolu_10", status: "failed", summary: "Next one", result: null },
    ]);
  });

  it("maps statuses to run ends", () => {
    expect(terminalStatus("completed")).toBe("done");
    expect(terminalStatus("success")).toBe("done");
    expect(terminalStatus("failed")).toBe("failed");
    expect(terminalStatus("killed")).toBe("stopped");
    expect(terminalStatus("running")).toBeNull();
  });

  it("collects them from user strings, text blocks, queue-operations and attachments, last one per task wins", async () => {
    const box = sandbox();
    try {
      const path = box.write(
        `${box.root}/t.jsonl`,
        jsonl([
          queueOperation(notification("a1", "toolu_a", "running", "Agent started")),
          attachmentPrompt(notification("a1", "toolu_a", "completed", 'Agent "x" finished', "report")),
          userPrompt(notification("b1", "toolu_b", "completed", "Background command done")),
          userPrompt([{ type: "text", text: notification("w1", "toolu_w", "killed", "Workflow killed") }]),
          queueOperation(notification("b1", "toolu_b", "completed", "Background command done")),
        ]),
      );
      const cache = new JsonlCache(transcriptReducer({ home: box.env.home, skipSidechain: true, keepSteps: true }));
      const notes = (await cache.read(path))?.state.notifications;
      expect([...(notes?.keys() ?? [])].sort()).toEqual(["a1", "b1", "w1"]);
      expect(notes?.get("a1")).toMatchObject({ status: "completed", result: "report", toolUseId: "toolu_a" });
      expect(notes?.get("w1")?.status).toBe("killed");
    } finally {
      box.cleanup();
    }
  });
});
