import { describe, expect, it } from "vitest";
import { JsonlCache } from "../server/jsonl";
import { contextTokens, transcriptReducer, type TranscriptState } from "../server/transcript";
import { assistant, jsonl, sandbox, text, thinking, toolResult, toolUse, userPrompt, type Line } from "./fixtures";

const HOME = "/Users/tester";

async function parse(lines: Line[], keepSteps = true): Promise<TranscriptState> {
  const box = sandbox();
  try {
    const path = box.write(`${box.root}/t.jsonl`, jsonl(lines));
    const cache = new JsonlCache(transcriptReducer({ home: HOME, skipSidechain: false, keepSteps }));
    const snapshot = await cache.read(path);
    if (!snapshot) throw new Error("not parsed");
    return snapshot.state;
  } finally {
    box.cleanup();
  }
}

describe("transcript tokens", () => {
  it("counts each streamed API message once, with the largest value of each counter", async () => {
    const state = await parse([
      ...assistant("msg_1", [thinking("plan"), text("hello"), toolUse("toolu_1", "Read", { file_path: `${HOME}/a.ts` })], { input: 10, output: 50, cacheRead: 1000, cacheWrite: 200 }),
      toolResult("toolu_1", "file body"),
      ...assistant("msg_2", [text("done")], { input: 3, output: 7, cacheRead: 1200, cacheWrite: 5 }, { stop: "end_turn" }),
      ...assistant("msg_synthetic", [text("No response requested.")], { input: 0, output: 0 }, { model: "<synthetic>" }),
    ]);
    expect(state.tokens).toEqual({ input: 13, output: 57, cacheRead: 2200, cacheWrite: 205 });
    expect(state.messages.size).toBe(2);
    expect(contextTokens(state)).toBe(3 + 1200 + 5);
    expect(state.model).toBe("claude-opus-5-5");
    expect(state.effort).toBe("high");
    expect(state.lastStopReason).toBe("end_turn");
  });

  it("keeps the same counters without the step list", async () => {
    const lines = [
      ...assistant("msg_1", [text("a"), toolUse("toolu_1", "Bash", { command: "ls" })], { input: 1, output: 9 }),
      toolResult("toolu_1", "out"),
    ];
    const full = await parse(lines, true);
    const summary = await parse(lines, false);
    expect(summary.tokens).toEqual(full.tokens);
    expect(summary.toolCalls).toBe(full.toolCalls);
    expect(summary.steps).toEqual([]);
    expect(full.steps).toHaveLength(2);
  });
});

describe("transcript steps", () => {
  it("pairs tool_use with tool_result, marks errors, leaves unanswered calls running", async () => {
    const state = await parse([
      userPrompt("<system-reminder>context</system-reminder>\nFix the build"),
      ...assistant("m1", [toolUse("t_ok", "Bash", { command: "npm test", description: "Run the tests" })], { output: 1 }),
      toolResult("t_ok", [{ type: "text", text: "\u001b[32m12 passed\u001b[0m" }]),
      ...assistant("m2", [toolUse("t_err", "Edit", { file_path: `${HOME}/src/x.ts`, old_string: "a", new_string: "b" })], { output: 1 }),
      toolResult("t_err", "String not found", { isError: true }),
      ...assistant("m3", [toolUse("t_run", "Grep", { pattern: "TODO", path: `${HOME}/src`, glob: "*.ts" })], { output: 1 }),
    ]);
    expect(state.prompt).toBe("Fix the build");
    expect(state.toolCalls).toBe(3);
    const [ok, error, running] = state.steps;
    expect(ok).toMatchObject({ id: "t_ok", tool: "Bash", title: "Run the tests", detail: "npm test", status: "ok", resultPreview: "12 passed" });
    expect(ok?.endedAt).not.toBeNull();
    expect(error).toMatchObject({ tool: "Edit", title: "~/src/x.ts", status: "error", resultPreview: "String not found", detail: "- a\n+ b" });
    expect(running).toMatchObject({ tool: "Grep", title: "TODO in ~/src", status: "running", endedAt: null, resultPreview: null });
    expect(running?.detail).toContain('"glob": "*.ts"');
  });

  it("titles each tool kind", async () => {
    const calls: Array<[string, Line]> = [
      ["Bash", { command: "git status\ngit diff" }],
      ["Read", { file_path: `${HOME}/notes.md` }],
      ["Write", { file_path: "/tmp/out.txt", content: "body" }],
      ["NotebookEdit", { notebook_path: `${HOME}/n.ipynb`, new_source: "x = 1" }],
      ["Glob", { pattern: "**/*.ts" }],
      ["WebFetch", { url: "https://example.com/doc", prompt: "summarise" }],
      ["WebSearch", { query: "paseo plugins" }],
      ["Agent", { description: "Review the diff", subagent_type: "Explore", prompt: "Look at it" }],
      ["Skill", { skill: "paseo-plugin", args: "reload" }],
      ["ToolSearch", { query: "select:Monitor" }],
      ["mcp__github__search_issues", { status: "open", limit: 5 }],
      ["Custom", { a: 1 }],
      ["Workflow", { script: "export const meta = { name: 'audit', description: 'Audit things', phases: [{ title: 'One' }, { title: 'Two' }] }" }],
    ];
    const state = await parse(calls.flatMap(([name, input], index) => assistant(`m${index}`, [toolUse(`t${index}`, name, input)], { output: 1 })));
    expect(state.steps.map((step) => step.title)).toEqual([
      "git status",
      "~/notes.md",
      "/tmp/out.txt",
      "~/n.ipynb",
      "**/*.ts",
      "https://example.com/doc",
      "paseo plugins",
      "Review the diff (Explore)",
      "paseo-plugin reload",
      "select:Monitor",
      "github · search_issues status=open limit=5",
      'Custom {"a":1}',
      "audit",
    ]);
    expect(state.steps[0]?.detail).toBe("git status\ngit diff");
    expect(state.steps[12]?.detail).toBe("Audit things\nPhases: One · Two");
  });

  it("turns text and thinking blocks into steps and keeps the last text", async () => {
    const state = await parse([
      ...assistant("m1", [thinking("First I check the logs.\nThen the code."), text("## Result\nAll good")], { output: 5 }, { stop: "end_turn" }),
    ]);
    expect(state.steps.map((step) => [step.kind, step.title, step.status])).toEqual([
      ["thinking", "First I check the logs.", "ok"],
      ["text", "## Result", "ok"],
    ]);
    expect(state.lastText).toBe("## Result\nAll good");
  });

  it("masks and cleans what it keeps", async () => {
    const state = await parse([
      ...assistant("m1", [toolUse("t1", "Bash", { command: "curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://api" })], { output: 1 }),
      toolResult("t1", "card 4111 1111 1111 1111\u0000"),
    ]);
    expect(state.steps[0]?.title).toBe("curl -H 'Authorization: Bearer ****' https://api");
    expect(state.steps[0]?.resultPreview).toBe("card **** 1111");
  });

  it("caps retained steps and counts the dropped ones", async () => {
    const lines = Array.from({ length: 1300 }, (_, index) => assistant(`m${index}`, [toolUse(`t${index}`, "Read", { file_path: `/f${index}` })], { output: 1 })).flat();
    const state = await parse(lines);
    expect(state.toolCalls).toBe(1300);
    expect(state.steps.length).toBeLessThanOrEqual(1200);
    expect(state.steps.length + state.droppedSteps).toBe(1300);
    expect(state.steps[state.steps.length - 1]?.title).toBe("/f1299");
  });
});

describe("todos", () => {
  it("keeps the latest TodoWrite list", async () => {
    const state = await parse([
      ...assistant("m1", [toolUse("t1", "TodoWrite", { todos: [{ content: "a", status: "pending", activeForm: "Doing a" }] })], { output: 1 }),
      ...assistant("m2", [toolUse("t2", "TodoWrite", { todos: [{ content: "a", status: "completed", activeForm: "Doing a" }, { content: "b", status: "in_progress", activeForm: "Doing b" }] })], { output: 1 }),
    ]);
    expect(state.todos).toEqual([
      { content: "a", status: "completed", activeForm: "Doing a" },
      { content: "b", status: "in_progress", activeForm: "Doing b" },
    ]);
  });

  it("rebuilds the list from TaskCreate and TaskUpdate", async () => {
    const state = await parse([
      ...assistant("m1", [toolUse("c1", "TaskCreate", { subject: "Catalogue", description: "d", activeForm: "Cataloguing" })], { output: 1 }),
      toolResult("c1", "Task #1 created successfully: Catalogue", { toolUseResult: { task: { id: "1", subject: "Catalogue" } } }),
      ...assistant("m2", [toolUse("c2", "TaskCreate", { subject: "Build", description: "d" })], { output: 1 }),
      toolResult("c2", "Task #2 created successfully: Build"),
      ...assistant("m3", [toolUse("c3", "TaskCreate", { subject: "Drop me", description: "d" })], { output: 1 }),
      toolResult("c3", "Task #3 created successfully: Drop me"),
      ...assistant("m4", [toolUse("u1", "TaskUpdate", { taskId: "1", status: "completed" })], { output: 1 }),
      ...assistant("m5", [toolUse("u2", "TaskUpdate", { taskId: "2", status: "in_progress", activeForm: "Building" })], { output: 1 }),
      ...assistant("m6", [toolUse("u3", "TaskUpdate", { taskId: "3", status: "deleted" })], { output: 1 }),
    ]);
    expect(state.todos).toEqual([
      { content: "Catalogue", status: "completed", activeForm: "Cataloguing" },
      { content: "Build", status: "in_progress", activeForm: "Building" },
    ]);
  });
});
