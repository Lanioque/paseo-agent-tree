import type { Todo, Tokens } from "../shared/contract";
import { DETAIL_MAX, LONG_TEXT_MAX, RESULT_MAX, TITLE_MAX, describeTool, firstLine, obj, resultText, str } from "./format";
import type { JsonObject, Reducer } from "./jsonl";
import { displayBlock, displayLine } from "./mask";
import { readWorkflowMeta, type WorkflowMeta } from "./meta-literal";
import { parseNotifications } from "./notifications";

// Reduces one Claude Code transcript (main session or one subagent) line by line into what the tree needs:
// token counters per API message, the step list, and the calls that start other work (Agent, Workflow,
// background Bash) with their results and task notifications.

export const MAX_STEPS = 1000;
/** Steps are trimmed in batches so that a long transcript does not shift the array on every line. */
const TRIM_SLACK = 200;

export interface StepRecord {
  id: string;
  at: string;
  endedAt: string | null;
  kind: "tool" | "text" | "thinking";
  tool: string | null;
  title: string;
  detail: string | null;
  status: "running" | "ok" | "error";
  resultPreview: string | null;
}

export interface AgentCall {
  toolUseId: string;
  at: string | null;
  description: string | null;
  subagentType: string | null;
  background: boolean;
  result: {
    at: string | null;
    isError: boolean;
    /** The result only acknowledges a background launch. */
    launchAck: boolean;
    agentId: string | null;
    text: string | null;
  } | null;
}

export interface WorkflowLaunch {
  toolUseId: string;
  at: string | null;
  meta: WorkflowMeta | null;
  /** input.scriptPath, read later when the script was not passed inline. */
  inputScriptPath: string | null;
  inputName: string | null;
  result: {
    at: string | null;
    isError: boolean;
    taskId: string | null;
    runId: string | null;
    transcriptDir: string | null;
    scriptPath: string | null;
    workflowName: string | null;
  } | null;
}

export interface ShellLaunch {
  toolUseId: string;
  at: string | null;
  title: string;
  taskId: string | null;
  outputFile: string | null;
  /** Started with run_in_background; false when moved to the background after its timeout (killed with the turn). */
  requested: boolean;
}

export interface NotificationRecord {
  taskId: string;
  toolUseId: string | null;
  status: string;
  summary: string | null;
  result: string | null;
  at: string | null;
}

export interface TranscriptState {
  firstAt: string | null;
  lastAt: string | null;
  /** Per API message id: the largest value seen of each counter (streamed copies repeat usage). */
  messages: Map<string, Tokens>;
  tokens: Tokens;
  lastMessageId: string | null;
  model: string | null;
  effort: string | null;
  steps: StepRecord[];
  droppedSteps: number;
  toolCalls: number;
  prompt: string | null;
  lastText: string | null;
  /** The report a subagent handed back through its SubagentHandback call. */
  handback: string | null;
  lastStopReason: string | null;
  agentCalls: Map<string, AgentCall>;
  workflowLaunches: Map<string, WorkflowLaunch>;
  shells: Map<string, ShellLaunch>;
  notifications: Map<string, NotificationRecord>;
  /** TaskStop / KillShell: task id → when it was stopped. */
  stopped: Map<string, string | null>;
  todos: Todo[];
  weight: number;
  open: Map<string, StepRecord>;
  seen: Set<string>;
  pendingCreates: Map<string, { subject: string; activeForm: string | null }>;
  pendingStops: Map<string, string>;
  taskList: Map<string, Todo>;
}

export function createTranscriptState(): TranscriptState {
  return {
    firstAt: null,
    lastAt: null,
    messages: new Map(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    lastMessageId: null,
    model: null,
    effort: null,
    steps: [],
    droppedSteps: 0,
    toolCalls: 0,
    prompt: null,
    lastText: null,
    handback: null,
    lastStopReason: null,
    agentCalls: new Map(),
    workflowLaunches: new Map(),
    shells: new Map(),
    notifications: new Map(),
    stopped: new Map(),
    todos: [],
    weight: 0,
    open: new Map(),
    seen: new Set(),
    pendingCreates: new Map(),
    pendingStops: new Map(),
    taskList: new Map(),
  };
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

function stepWeight(step: StepRecord): number {
  return step.title.length + (step.detail?.length ?? 0) + (step.resultPreview?.length ?? 0) + 96;
}

function pushStep(state: TranscriptState, step: StepRecord): void {
  if (state.seen.has(step.id)) return;
  state.seen.add(step.id);
  state.steps.push(step);
  state.weight += stepWeight(step);
  if (step.status === "running") state.open.set(step.id, step);
  if (state.steps.length > MAX_STEPS + TRIM_SLACK) {
    const removed = state.steps.splice(0, state.steps.length - MAX_STEPS);
    state.droppedSteps += removed.length;
    for (const old of removed) {
      state.weight -= stepWeight(old);
      state.open.delete(old.id);
    }
  }
}

function addUsage(state: TranscriptState, id: string, usage: JsonObject): void {
  const next: Tokens = {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
  };
  const previous = state.messages.get(id);
  if (!previous) {
    state.messages.set(id, next);
    state.tokens.input += next.input;
    state.tokens.output += next.output;
    state.tokens.cacheRead += next.cacheRead;
    state.tokens.cacheWrite += next.cacheWrite;
    return;
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (next[key] > previous[key]) {
      state.tokens[key] += next[key] - previous[key];
      previous[key] = next[key];
    }
  }
}

function todoStatus(value: unknown): Todo["status"] {
  return value === "in_progress" || value === "completed" ? value : "pending";
}

function readTodos(value: unknown, home: string): Todo[] {
  if (!Array.isArray(value)) return [];
  const todos: Todo[] = [];
  for (const entry of value) {
    const todo = obj(entry);
    const content = str(todo?.content) ?? str(todo?.subject);
    if (!todo || !content) continue;
    const activeForm = str(todo.activeForm);
    todos.push({ content: displayLine(content, 300, home), status: todoStatus(todo.status), activeForm: activeForm ? displayLine(activeForm, 300, home) : null });
  }
  return todos;
}

function setTaskTodos(state: TranscriptState): void {
  const entries = [...state.taskList.entries()];
  const numeric = entries.every(([id]) => /^\d+$/.test(id));
  if (numeric) entries.sort(([a], [b]) => Number(a) - Number(b));
  state.todos = entries.map(([, todo]) => todo);
}

/** Text of a user line: string content, or its text blocks. */
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    const block = obj(entry);
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * The latest notification of each task, dated by its first copy: Claude Code writes the same block again when it
 * delivers it to a busy agent, minutes (sometimes hours) after the task ended.
 */
function recordNotifications(state: TranscriptState, text: string, at: string | null): void {
  for (const note of parseNotifications(text)) {
    const known = state.notifications.get(note.taskId);
    const first = known && known.status === note.status ? known.at ?? at : at;
    state.notifications.set(note.taskId, { ...note, at: first });
  }
}

const matchOne = (text: string, pattern: RegExp): string | null => pattern.exec(text)?.[1]?.trim() ?? null;

/** Claude Code's sentence ends right after the path: "Output is being written to: /…/tasks/<id>.output." */
const OUTPUT_FILE = /Output is being written to:\s*(\S+?)[.,;]*(?=\s|$)/;

/** What an Agent call returns when the report went through SubagentHandback instead (Claude Code 2.1.299+). */
const HANDBACK_PLACEHOLDER = /^This agent's report was delivered to you as a message from/;

/** The text unless it is the handback placeholder. */
export function reportText(value: string | null | undefined): string | null {
  return value && !HANDBACK_PLACEHOLDER.test(value.trim()) ? value : null;
}

export interface TranscriptOptions {
  home: string;
  /** Main transcripts skip sidechain lines (older Claude Code wrote subagent turns inline). */
  skipSidechain: boolean;
  /** False for the overview: counters, statuses and links only, no step list or texts. */
  keepSteps: boolean;
}

export function transcriptReducer(options: TranscriptOptions): Reducer<TranscriptState> {
  const { home, keepSteps } = options;

  function onAssistant(state: TranscriptState, line: JsonObject, at: string | null): void {
    const message = obj(line.message);
    if (!message) return;
    const model = str(message.model);
    const synthetic = model === "<synthetic>";
    const id = str(message.id) ?? str(line.uuid);
    const usage = obj(message.usage);
    if (id && usage && !synthetic) {
      addUsage(state, id, usage);
      state.lastMessageId = id;
    }
    if (model && !synthetic) state.model = model;
    const effort = str(line.effort);
    if (effort) state.effort = effort;
    const stop = str(message.stop_reason);
    if (stop && !synthetic) state.lastStopReason = stop;
    const content = Array.isArray(message.content) ? message.content : [];
    const uuid = str(line.uuid) ?? id ?? String(state.steps.length + state.droppedSteps);
    content.forEach((entry, index) => {
      const block = obj(entry);
      if (!block) return;
      const when = at ?? state.lastAt ?? "";
      if (block.type === "tool_use") onToolUse(state, block, when);
      else if (!keepSteps) return;
      else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        const text = block.text;
        // Claude Code's own placeholders ("No response requested.") are not the agent's answer.
        if (!synthetic) state.lastText = displayBlock(text, LONG_TEXT_MAX, home);
        const title = displayLine(firstLine(text), TITLE_MAX, home);
        pushStep(state, { id: `${uuid}:${index}`, at: when, endedAt: null, kind: "text", tool: null, title, detail: text.trim().length > title.length ? displayBlock(text, DETAIL_MAX, home) : null, status: "ok", resultPreview: null });
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        const text = typeof block.thinking === "string" ? block.thinking : "";
        const title = text.trim() ? displayLine(firstLine(text), TITLE_MAX, home) : "Thinking";
        pushStep(state, { id: `${uuid}:${index}`, at: when, endedAt: null, kind: "thinking", tool: null, title, detail: text.trim().length > title.length ? displayBlock(text, DETAIL_MAX, home) : null, status: "ok", resultPreview: null });
      }
    });
  }

  function onToolUse(state: TranscriptState, block: JsonObject, at: string): void {
    const id = str(block.id);
    const name = str(block.name);
    if (!id || !name || state.seen.has(id)) return;
    const input = obj(block.input) ?? {};
    state.toolCalls += 1;
    if (!keepSteps) state.seen.add(id);
    let meta: WorkflowMeta | null = null;
    if (name === "Workflow") {
      const script = str(input.script);
      meta = script ? readWorkflowMeta(script) : null;
      state.workflowLaunches.set(id, { toolUseId: id, at, meta, inputScriptPath: str(input.scriptPath), inputName: str(input.name), result: null });
    } else if (name === "Agent" || name === "Task") {
      state.agentCalls.set(id, { toolUseId: id, at, description: str(input.description), subagentType: str(input.subagent_type), background: input.run_in_background === true, result: null });
    } else if (name === "TodoWrite") {
      state.todos = readTodos(input.todos, home);
    } else if (name === "TaskCreate") {
      const subject = str(input.subject) ?? str(input.description);
      if (subject) state.pendingCreates.set(id, { subject, activeForm: str(input.activeForm) });
    } else if (name === "TaskUpdate") {
      const taskId = input.taskId === undefined || input.taskId === null ? null : String(input.taskId);
      if (taskId) {
        if (input.status === "deleted") state.taskList.delete(taskId);
        else {
          const current = state.taskList.get(taskId) ?? { content: `Task #${taskId}`, status: "pending" as const, activeForm: null };
          const subject = str(input.subject);
          const activeForm = str(input.activeForm);
          state.taskList.set(taskId, {
            content: subject ? displayLine(subject, 300, home) : current.content,
            status: input.status === undefined ? current.status : todoStatus(input.status),
            activeForm: activeForm ? displayLine(activeForm, 300, home) : current.activeForm,
          });
        }
        setTaskTodos(state);
      }
    } else if (name === "TaskStop" || name === "KillShell" || name === "KillBash") {
      const taskId = str(input.task_id) ?? str(input.shell_id) ?? str(input.bash_id);
      if (taskId) state.pendingStops.set(id, taskId);
    } else if (name === "SubagentHandback" && keepSteps) {
      const message = str(input.message);
      if (message) state.handback = displayBlock(message, LONG_TEXT_MAX, home);
    }
    if (name === "Bash" && input.run_in_background === true) {
      const text = describeTool(name, input, home, null);
      state.shells.set(id, { toolUseId: id, at, title: text.title, taskId: null, outputFile: null, requested: true });
    }
    if (!keepSteps) return;
    const workflowLabel = meta ? { name: meta.name, description: meta.description, phases: meta.phases.map((phase) => phase.title) } : null;
    const { title, detail } = describeTool(name, input, home, workflowLabel);
    pushStep(state, { id, at, endedAt: null, kind: "tool", tool: name, title, detail, status: "running", resultPreview: null });
  }

  function onToolResult(state: TranscriptState, block: JsonObject, extra: JsonObject | null, at: string | null): void {
    const id = str(block.tool_use_id);
    if (!id) return;
    const isError = block.is_error === true;
    const text = resultText(block.content);
    // A foreground Agent call's content is the handback placeholder; the report rides along in toolUseResult.
    const report = str(obj(extra?.handbackReport)?.text);
    const step = state.open.get(id);
    if (step) {
      state.open.delete(id);
      state.weight -= stepWeight(step);
      step.status = isError ? "error" : "ok";
      step.endedAt = at;
      const shown = report ?? text;
      step.resultPreview = shown ? displayBlock(shown, RESULT_MAX, home) : null;
      state.weight += stepWeight(step);
    }

    const call = state.agentCalls.get(id);
    if (call && !call.result) {
      const async = extra?.isAsync === true || extra?.status === "async_launched" || /^Async agent launched/i.test(text.trim());
      if (async) call.background = true;
      call.result = {
        at,
        isError,
        launchAck: async,
        agentId: str(extra?.agentId) ?? matchOne(text, /agentId:\s*([A-Za-z0-9_-]+)/),
        text: async ? null : displayBlock(report ?? (resultText(extra?.content) || text), LONG_TEXT_MAX, home),
      };
    }
    const launch = state.workflowLaunches.get(id);
    if (launch && !launch.result) {
      launch.result = {
        at,
        isError,
        taskId: str(extra?.taskId) ?? matchOne(text, /Task ID:\s*(\S+)/),
        runId: str(extra?.runId) ?? matchOne(text, /Run ID:\s*(\S+)/),
        transcriptDir: str(extra?.transcriptDir) ?? matchOne(text, /Transcript dir:\s*(.+)/),
        scriptPath: str(extra?.scriptPath) ?? matchOne(text, /Script file:\s*(.+)/),
        workflowName: str(extra?.workflowName),
      };
    }
    // A Bash call that runs in the background, asked for or moved there after its timeout. The text fallback only
    // reads Claude Code's own first line ("Command running in background with ID: …", "Command did not complete …
    // moved to the background (ID: …)"), so command output that mentions a background id does not count.
    const backgroundId = str(extra?.backgroundTaskId) ?? matchOne(firstLine(text), /^Command\b.*\bbackground\b.*?\bID:\s*([A-Za-z0-9_-]+)/i);
    if (backgroundId && (step?.tool === "Bash" || state.shells.has(id) || str(extra?.backgroundTaskId))) {
      const shell = state.shells.get(id) ?? { toolUseId: id, at: step?.at ?? at, title: step?.title ?? "Background command", taskId: null, outputFile: null, requested: false };
      shell.taskId = backgroundId;
      shell.outputFile = matchOne(text, OUTPUT_FILE);
      state.shells.set(id, shell);
    }
    const create = state.pendingCreates.get(id);
    if (create) {
      state.pendingCreates.delete(id);
      const task = obj(extra?.task);
      const taskId = (task && task.id !== undefined ? String(task.id) : null) ?? matchOne(text, /Task #(\w+)/);
      if (taskId && !isError) {
        state.taskList.set(taskId, { content: displayLine(create.subject, 300, home), status: "pending", activeForm: create.activeForm ? displayLine(create.activeForm, 300, home) : null });
        setTaskTodos(state);
      }
    }
    const stopId = state.pendingStops.get(id);
    if (stopId) {
      state.pendingStops.delete(id);
      const taskId = str(extra?.task_id) ?? stopId;
      if (!isError) state.stopped.set(taskId, at);
    }
  }

  function onUser(state: TranscriptState, line: JsonObject, at: string | null): void {
    const message = obj(line.message);
    if (!message) return;
    const content = message.content;
    const text = userText(content);
    if (text) recordNotifications(state, text, at);
    if (keepSteps && !state.prompt && line.isMeta !== true) {
      // Harness context Claude Code prepends to a first message is not what the agent was asked.
      const asked = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
      if (asked) state.prompt = displayBlock(asked, LONG_TEXT_MAX, home);
    }
    if (!Array.isArray(content)) return;
    const results = content.map(obj).filter((block): block is JsonObject => block?.type === "tool_result");
    const extra = obj(line.toolUseResult);
    const source = str(line.sourceToolUseID);
    for (const block of results) {
      const own = results.length === 1 || (source !== null && block.tool_use_id === source);
      onToolResult(state, block, own ? extra : null, at);
    }
  }

  return {
    create: createTranscriptState,
    weight: (state) => state.weight + (state.prompt?.length ?? 0) + (state.lastText?.length ?? 0) + (state.handback?.length ?? 0),
    apply(state, line) {
      if (options.skipSidechain && line.isSidechain === true) return;
      const at = str(line.timestamp);
      if (at) {
        if (!state.firstAt || at < state.firstAt) state.firstAt = at;
        if (!state.lastAt || at > state.lastAt) state.lastAt = at;
      }
      const type = line.type;
      if (type === "assistant") onAssistant(state, line, at);
      else if (type === "user") onUser(state, line, at);
      else if (type === "queue-operation") {
        const content = str(line.content);
        if (content) recordNotifications(state, content, at);
      } else if (type === "attachment") {
        const prompt = str(obj(line.attachment)?.prompt);
        if (prompt) recordNotifications(state, prompt, at);
      }
    },
  };
}

/** Context size of the latest API call: input + cache read + cache write. */
export function contextTokens(state: TranscriptState): number | null {
  const last = state.lastMessageId ? state.messages.get(state.lastMessageId) : undefined;
  return last ? last.input + last.cacheRead + last.cacheWrite : null;
}
