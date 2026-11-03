import { displayBlock, displayLine, maskSensitive } from "./mask";
import type { JsonObject } from "./jsonl";

// Human titles and previews for transcript steps. Every string goes through displayLine/displayBlock: control
// characters stripped, $HOME shortened, sensitive values masked, length capped.

export const TITLE_MAX = 160;
export const DETAIL_MAX = 800;
export const RESULT_MAX = 600;
export const LONG_TEXT_MAX = 4000;

export function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function obj(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function safeJson(value: unknown, indent?: number): string {
  try {
    return JSON.stringify(value, null, indent) ?? "";
  } catch {
    return "";
  }
}

/** key=value pairs of the inputs, each value masked then cut to 60 characters, for one-line titles. */
function compactArgs(input: JsonObject): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined || value === "") continue;
    const shown = maskSensitive(typeof value === "string" ? firstLine(value) : typeof value === "object" ? safeJson(value) : String(value));
    parts.push(`${key}=${shown.length > 60 ? `${shown.slice(0, 59)}…` : shown}`);
  }
  return parts.join(" ");
}

/** Input fields other than the ones the title already shows, pretty-printed; null when none are left. */
function restJson(input: JsonObject, shown: readonly string[], home: string): string | null {
  const rest: JsonObject = {};
  for (const [key, value] of Object.entries(input)) if (!shown.includes(key) && value !== undefined) rest[key] = value;
  return Object.keys(rest).length ? displayBlock(safeJson(rest, 2), DETAIL_MAX, home) : null;
}

export interface ToolText {
  title: string;
  detail: string | null;
}

/** Display name of a Workflow call, from its meta when the script declares one. */
export interface WorkflowLabel {
  name: string | null;
  description: string | null;
  phases: readonly string[];
}

export function describeTool(name: string, input: JsonObject, home: string, workflow: WorkflowLabel | null): ToolText {
  const line = (text: string): string => displayLine(text, TITLE_MAX, home);
  const block = (text: string | null): string | null => (text ? displayBlock(text, DETAIL_MAX, home) : null);
  const titled = (title: string, detail: string | null): ToolText => {
    const shownTitle = line(title) || name;
    return { title: shownTitle, detail: detail && detail !== shownTitle ? detail : null };
  };

  if (name === "Bash") {
    const command = str(input.command) ?? "";
    const description = str(input.description);
    if (description) return titled(description, block(command));
    const head = firstLine(command);
    return titled(head || "Bash", command.trim() !== head || head.length > TITLE_MAX ? block(command) : null);
  }
  if (name === "Read" || name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") {
    const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? name;
    if (name === "Write") return titled(path, block(str(input.content)));
    if (name === "Edit") {
      const before = str(input.old_string), after = str(input.new_string);
      const half = (value: string): string => maskSensitive(value.slice(0, DETAIL_MAX)).slice(0, DETAIL_MAX / 2);
      const diff = [before ? `- ${half(before)}` : null, after ? `+ ${half(after)}` : null].filter(Boolean).join("\n");
      return titled(path, block(diff || null));
    }
    if (name === "NotebookEdit") return titled(path, block(str(input.new_source)));
    return titled(path, restJson(input, ["file_path"], home));
  }
  if (name === "Glob" || name === "Grep") {
    const pattern = str(input.pattern) ?? "";
    const path = str(input.path);
    return titled(path ? `${pattern} in ${path}` : pattern || name, restJson(input, ["pattern", "path"], home));
  }
  if (name === "WebFetch") return titled(str(input.url) ?? name, block(str(input.prompt)));
  if (name === "WebSearch") return titled(str(input.query) ?? name, restJson(input, ["query"], home));
  if (name === "Agent" || name === "Task") {
    const type = str(input.subagent_type);
    const description = str(input.description) ?? (firstLine(str(input.prompt) ?? "") || name);
    return titled(type && type !== "general-purpose" ? `${description} (${type})` : description, block(str(input.prompt)));
  }
  if (name === "Workflow") {
    const title = workflow?.name ?? workflow?.description ?? str(input.name) ?? str(input.scriptPath) ?? "Workflow";
    const lines = [workflow?.description && workflow.description !== title ? workflow.description : null, workflow?.phases.length ? `Phases: ${workflow.phases.join(" · ")}` : null];
    return titled(title, block(lines.filter(Boolean).join("\n") || null));
  }
  if (name === "Skill") {
    const skill = str(input.skill) ?? str(input.command) ?? "Skill";
    const args = str(input.args);
    return titled(args ? `${skill} ${firstLine(args)}` : skill, args && args.length > 80 ? block(args) : null);
  }
  if (name === "ToolSearch") return titled(str(input.query) ?? name, null);
  if (name === "TodoWrite") {
    const todos = Array.isArray(input.todos) ? input.todos.length : 0;
    return titled(`Todo list (${todos} items)`, null);
  }
  // A workflow agent's last call: its whole return value as input. The title stays short; the JSON is the detail.
  if (name === "StructuredOutput") return titled("Returned result", block(safeJson(input, 2)));
  if (name === "TaskCreate") return titled(`New task: ${str(input.subject) ?? ""}`, block(str(input.description)));
  if (name === "TaskUpdate") return titled(`Task #${String(input.taskId ?? "?")} ${str(input.status) ?? "updated"}`, null);
  if (name.startsWith("mcp__")) {
    const [server = "", ...tool] = name.slice(5).split("__");
    const args = compactArgs(input);
    const full = displayBlock(safeJson(input, 2), DETAIL_MAX, home);
    return titled(`${server} · ${tool.join("__")}${args ? ` ${args}` : ""}`, Object.keys(input).length ? full : null);
  }
  const compact = safeJson(input);
  return titled(compact && compact !== "{}" ? `${name} ${compact}` : name, Object.keys(input).length ? block(safeJson(input, 2)) : null);
}

/** Text of a tool_result `content`: a string, or text blocks (images shown as a marker). */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    const block = obj(entry);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[image]");
    else if (block.type === "tool_reference" && typeof block.tool_name === "string") parts.push(`[tool ${block.tool_name}]`);
  }
  return parts.join("\n");
}
