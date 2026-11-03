import { appendFileSync, renameSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JsonlCache } from "../server/jsonl";
import { transcriptReducer, type TranscriptState } from "../server/transcript";
import { assistant, jsonl, notification, queueOperation, sandbox, text, toolResult, toolUse } from "./fixtures";

const reducer = () => transcriptReducer({ home: "/Users/tester", skipSidechain: false, keepSteps: true });

function view(state: TranscriptState) {
  return {
    tokens: state.tokens,
    turns: state.messages.size,
    toolCalls: state.toolCalls,
    steps: state.steps.map((step) => [step.id, step.status, step.title, step.resultPreview]),
    notifications: [...state.notifications.keys()],
    lastText: state.lastText,
  };
}

describe("incremental parsing", () => {
  it("reads only appended bytes, keeps the partial line, and matches a cold parse", async () => {
    const box = sandbox();
    try {
      const first = jsonl([...assistant("m1", [text("héllo ünïcode ✓"), toolUse("t1", "Bash", { command: "sleep 1" })], { input: 5, output: 20 })]);
      const second = jsonl([
        toolResult("t1", "slept"),
        ...assistant("m2", [toolUse("t2", "Read", { file_path: "/a" })], { input: 2, output: 3 }),
        queueOperation(notification("b1", "t1", "completed", "done")),
      ]);
      // Cut in the middle of the multi-byte text of the first line.
      const cut = Buffer.byteLength(first.slice(0, first.indexOf("ü") + 1)) - 1;
      const path = box.write(`${box.root}/t.jsonl`, "");
      const bytes = Buffer.from(first);
      appendFileSync(path, bytes.subarray(0, cut));

      const cache = new JsonlCache(reducer());
      const partial = await cache.read(path);
      expect(partial?.state.messages.size).toBe(0);

      appendFileSync(path, bytes.subarray(cut));
      const afterFirst = await cache.read(path);
      expect(afterFirst?.state.toolCalls).toBe(1);
      expect(afterFirst?.state.steps[1]?.status).toBe("running");

      appendFileSync(path, second.slice(0, 40));
      await cache.read(path);
      appendFileSync(path, second.slice(40));
      const warm = await cache.read(path);

      const cold = await new JsonlCache(reducer()).read(path);
      expect(warm && view(warm.state)).toEqual(cold && view(cold.state));
      expect(warm?.state.steps[1]).toMatchObject({ status: "ok", resultPreview: "slept" });
      expect(warm?.state.steps[0]?.title).toBe("héllo ünïcode ✓");
    } finally {
      box.cleanup();
    }
  });

  it("starts over when the file shrinks or is replaced", async () => {
    const box = sandbox();
    try {
      const path = box.write(`${box.root}/t.jsonl`, jsonl(assistant("m1", [text("one"), text("two")], { output: 4 })));
      const cache = new JsonlCache(reducer());
      expect((await cache.read(path))?.state.steps).toHaveLength(2);

      box.write(path, jsonl(assistant("m9", [text("x")], { output: 1 })));
      const shrunk = await cache.read(path);
      expect(shrunk?.state.steps.map((step) => step.title)).toEqual(["x"]);
      expect(shrunk?.state.tokens.output).toBe(1);

      const replacement = box.write(`${box.root}/next.jsonl`, jsonl(assistant("m7", [text("a"), text("b"), text("c")], { output: 2 })));
      renameSync(replacement, path);
      const replaced = await cache.read(path);
      expect(replaced?.state.steps.map((step) => step.title)).toEqual(["a", "b", "c"]);
      expect(replaced?.state.tokens.output).toBe(2);
    } finally {
      box.cleanup();
    }
  });

  it("skips corrupt lines and serialises overlapping reads", async () => {
    const box = sandbox();
    try {
      const path = box.write(`${box.root}/t.jsonl`, `not json\n[1,2]\n${jsonl(assistant("m1", [text("ok")], { output: 3 }))}{"type":"assistant","message":5}\n`);
      const cache = new JsonlCache(reducer());
      const [a, b] = await Promise.all([cache.read(path), cache.read(path)]);
      expect(a?.state.tokens.output).toBe(3);
      expect(b?.state.steps).toHaveLength(1);
      expect(await cache.read(`${box.root}/missing.jsonl`)).toBeNull();
    } finally {
      box.cleanup();
    }
  });
});
