import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionTreeSchema } from "../shared/contract";
import type { Env } from "../server/env";
import { projectDirName } from "../server/env";
import { createHandlers } from "../server/rpc";
import { SessionStore } from "../server/session";

// Synthetic Claude Code / Paseo files with the real on-disk shapes (no real transcript content).

export type Line = Record<string, unknown>;

let clock = Date.parse("2026-11-03T08:00:00.000Z");
/** Monotonic ISO timestamps for fixture lines. */
export function at(stepMs = 1000): string {
  clock += stepMs;
  return new Date(clock).toISOString();
}

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const usage = (value: Usage) => ({
  input_tokens: value.input ?? 0,
  output_tokens: value.output ?? 0,
  cache_read_input_tokens: value.cacheRead ?? 0,
  cache_creation_input_tokens: value.cacheWrite ?? 0,
});

/** One API message streamed as one line per content block; only the last line carries the final output count. */
export function assistant(id: string, blocks: Line[], final: Usage, options: { model?: string; effort?: string; stop?: string; extra?: Line } = {}): Line[] {
  return blocks.map((block, index) => ({
    type: "assistant",
    uuid: `${id}-u${index}`,
    timestamp: at(),
    effort: options.effort ?? "high",
    ...options.extra,
    message: {
      id,
      model: options.model ?? "claude-opus-5-5",
      role: "assistant",
      content: [block],
      stop_reason: index === blocks.length - 1 ? options.stop ?? "tool_use" : null,
      usage: usage({ ...final, output: index === blocks.length - 1 ? final.output : Math.min(1, final.output ?? 0) }),
    },
  }));
}

export const toolUse = (id: string, name: string, input: Line): Line => ({ type: "tool_use", id, name, input });
export const text = (value: string): Line => ({ type: "text", text: value });
export const thinking = (value: string): Line => ({ type: "thinking", thinking: value, signature: "sig" });

export function toolResult(toolUseId: string, content: unknown, options: { isError?: boolean; toolUseResult?: unknown; extra?: Line } = {}): Line {
  return {
    type: "user",
    uuid: `r-${toolUseId}`,
    timestamp: at(),
    sourceToolUseID: toolUseId,
    ...options.extra,
    ...(options.toolUseResult === undefined ? {} : { toolUseResult: options.toolUseResult }),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...(options.isError ? { is_error: true } : {}) }] },
  };
}

export const userPrompt = (content: unknown, extra: Line = {}): Line => ({ type: "user", uuid: `p-${clock}`, timestamp: at(), ...extra, message: { role: "user", content } });

export function notification(taskId: string, toolUseId: string, status: string, summary: string, result?: string): string {
  return [
    "<task-notification>",
    `<task-id>${taskId}</task-id>`,
    `<tool-use-id>${toolUseId}</tool-use-id>`,
    `<output-file>/private/tmp/claude-501/x/tasks/${taskId}.output</output-file>`,
    `<status>${status}</status>`,
    `<summary>${summary}</summary>`,
    result === undefined ? "" : `<result>${result}</result>`,
    "</task-notification>",
  ].join("\n");
}

export const queueOperation = (content: string): Line => ({ type: "queue-operation", operation: "enqueue", timestamp: at(), content });
export const attachmentPrompt = (prompt: string): Line => ({ type: "attachment", uuid: `a-${clock}`, timestamp: at(), attachment: { type: "queued_command", prompt, commandMode: "task-notification" } });

export const jsonl = (lines: readonly Line[]): string => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

export interface Sandbox {
  root: string;
  env: Env;
  write(path: string, content: string): string;
  /** Sets a file's mtime `ageMs` before the fixture clock's now. */
  age(path: string, ageMs: number, now: number): void;
  /** <claude>/projects/<projDir>/<sessionId>.jsonl */
  transcript(cwd: string, sessionId: string): string;
  sessionDir(cwd: string, sessionId: string): string;
  record(fields: Line): string;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "agent-tree-"));
  const env: Env = { home: join(root, "home"), paseoHome: join(root, "paseo"), claudeDirs: [join(root, "claude")] };
  const write = (path: string, content: string): string => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  return {
    root,
    env,
    write,
    age: (path, ageMs, now) => {
      const when = new Date(now - ageMs);
      utimesSync(path, when, when);
    },
    transcript: (cwd, sessionId) => join(env.claudeDirs[0] ?? "", "projects", projectDirName(cwd), `${sessionId}.jsonl`),
    sessionDir: (cwd, sessionId) => join(env.claudeDirs[0] ?? "", "projects", projectDirName(cwd), sessionId),
    record: (fields) => {
      const id = String(fields.id);
      const cwd = typeof fields.cwd === "string" ? fields.cwd : "/x";
      return write(join(env.paseoHome, "agents", cwd.replace(/^\//, "").replace(/\//g, "-"), `${id}.json`), JSON.stringify(fields));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A Paseo record for a Claude Code agent on `sessionId`. */
export function claudeRecord(id: string, cwd: string, sessionId: string, extra: Line = {}): Line {
  return {
    id,
    provider: "claude",
    cwd,
    workspaceId: "wks_test",
    title: "Test agent",
    lastStatus: "idle",
    lastActivityAt: new Date(clock).toISOString(),
    persistence: { provider: "claude", sessionId },
    runtimeInfo: { provider: "claude", sessionId, model: "claude-opus-5-5" },
    ...extra,
  };
}

/** The fixture clock's current instant, for handlers created with a fixed clock. */
export const fixtureNow = (): number => clock;

/** RPC handlers over a fresh store for the sandbox, at a fixed instant. */
export function handlersFor(box: Sandbox, now: () => number = fixtureNow) {
  return createHandlers(new SessionStore(box.env), now);
}

/** Calls tree.get and checks the output against the contract. */
export async function treeOf(box: Sandbox, agentId: string, now: () => number = fixtureNow) {
  return sessionTreeSchema.parse(await handlersFor(box, now).tree({ agentId }));
}
