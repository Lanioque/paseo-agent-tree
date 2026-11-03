import type { AgentNode, AgentSteps, BackgroundTask, Counts, Phase, RunStatus, SessionSummary, SessionTree, Step, Tokens, Workflow } from "../shared/contract";
import { LONG_TEXT_MAX, RESULT_MAX, firstLine } from "./format";
import { resultFailed, resultString, type JournalAgent } from "./journal";
import { displayBlock, displayLine } from "./mask";
import { terminalStatus, type TerminalStatus } from "./notifications";
import type { ChildData, RunData, SessionData } from "./session";
import { contextTokens, reportText, type AgentCall, type NotificationRecord, type StepRecord, type TranscriptState } from "./transcript";

// Turns the parsed session files into the contract's SessionTree, applying the status rules:
// a terminal event (journal result, tool result, task notification) decides; without one, recent activity
// means running and none for STALE_MS means stopped.

export const STALE_MS = 30 * 60_000;
const NO_PHASE = "(no phase)";

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function addTokens(total: Tokens, more: Tokens): void {
  total.input += more.input;
  total.output += more.output;
  total.cacheRead += more.cacheRead;
  total.cacheWrite += more.cacheWrite;
}

function countNodes(nodes: readonly AgentNode[]): Counts {
  const counts: Counts = { total: nodes.length, running: 0, done: 0, failed: 0 };
  for (const node of nodes) {
    if (node.status === "running") counts.running += 1;
    else if (node.status === "done") counts.done += 1;
    else if (node.status === "failed") counts.failed += 1;
  }
  return counts;
}

const parseTime = (iso: string | null | undefined): number => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : 0;
};

const iso = (ms: number): string | null => (ms > 0 ? new Date(ms).toISOString() : null);

const latest = (...values: Array<string | null | undefined>): string | null => {
  let best: string | null = null;
  for (const value of values) if (value && (!best || parseTime(value) > parseTime(best))) best = value;
  return best;
};

/** Last sign of life of a transcript: its newest line or its last write. */
function activityMs(child: ChildData): number {
  return Math.max(parseTime(child.snapshot.state.lastAt), child.snapshot.mtimeMs);
}

/** A finished agent's tool calls that never got a result (its closing StructuredOutput, say) are not still running. */
function toStep(record: StepRecord, finished: boolean): Step {
  return {
    id: record.id,
    at: record.at,
    endedAt: record.endedAt,
    kind: record.kind,
    tool: record.tool,
    title: record.title,
    detail: record.detail,
    status: finished && record.status === "running" ? "ok" : record.status,
    resultPreview: record.resultPreview,
  };
}

function currentStep(state: TranscriptState, finished: boolean): Step | null {
  const steps = state.steps;
  if (!finished) {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index];
      if (step && step.kind === "tool" && step.status === "running") return toStep(step, false);
    }
  }
  const last = steps[steps.length - 1];
  return last ? toStep(last, finished) : null;
}

interface Links {
  now: number;
  home: string;
  /** Task notifications of every transcript, by task id; the latest status wins, dated by its first copy. */
  notifications: Map<string, NotificationRecord>;
  byToolUse: Map<string, NotificationRecord>;
  calls: Map<string, AgentCall>;
  callsByAgent: Map<string, AgentCall>;
  stopped: Map<string, string | null>;
  /** Subagent transcripts by the tool_use id of the Agent call that spawned them (meta.toolUseId). */
  spawned: Map<string, ChildData>;
}

function mergeNotification(known: NotificationRecord | undefined, note: NotificationRecord): NotificationRecord {
  if (!known) return note;
  const knownMs = parseTime(known.at);
  const noteMs = parseTime(note.at);
  if (known.status === note.status) return noteMs > 0 && (knownMs === 0 || noteMs < knownMs) ? note : known;
  return noteMs >= knownMs ? note : known;
}

function links(data: SessionData, now: number, home: string): Links {
  const states = [data.main.state, ...data.subagents.map((child) => child.snapshot.state), ...data.runs.flatMap((run) => run.agents.map((child) => child.snapshot.state))];
  const result: Links = { now, home, notifications: new Map(), byToolUse: new Map(), calls: new Map(), callsByAgent: new Map(), stopped: new Map(), spawned: new Map() };
  for (const child of data.subagents) if (child.meta?.toolUseId) result.spawned.set(child.meta.toolUseId, child);
  for (const state of states) {
    for (const note of state.notifications.values()) result.notifications.set(note.taskId, mergeNotification(result.notifications.get(note.taskId), note));
    for (const call of state.agentCalls.values()) {
      result.calls.set(call.toolUseId, call);
      if (call.result?.agentId) result.callsByAgent.set(call.result.agentId, call);
    }
    for (const [taskId, at] of state.stopped) result.stopped.set(taskId, at);
  }
  for (const note of result.notifications.values()) if (note.toolUseId) result.byToolUse.set(note.toolUseId, note);
  return result;
}

interface NodeFacts {
  kind: AgentNode["kind"];
  id: string;
  label: string;
  agentType: string | null;
  phase: string | null;
  depth: number;
  background: boolean;
  status: RunStatus;
  endedAt: string | null;
  result: string | null;
}

/** `earlier`: previous attempts of the same journal key, whose work counts in the row's totals. */
function agentNode(child: ChildData | undefined, facts: NodeFacts, home: string, earlier: readonly ChildData[] = []): AgentNode {
  const state = child?.snapshot.state;
  const finished = facts.status === "done";
  const tokens = state ? { ...state.tokens } : zero();
  let toolCalls = state?.toolCalls ?? 0;
  let turns = state?.messages.size ?? 0;
  for (const attempt of earlier) {
    addTokens(tokens, attempt.snapshot.state.tokens);
    toolCalls += attempt.snapshot.state.toolCalls;
    turns += attempt.snapshot.state.messages.size;
  }
  return {
    id: facts.id,
    kind: facts.kind,
    label: displayLine(facts.label, 200, home) || facts.id,
    agentType: facts.agentType ? displayLine(facts.agentType, 80, home) : null,
    phase: facts.phase === null ? null : displayLine(facts.phase, 120, home),
    depth: facts.depth,
    background: facts.background,
    status: facts.status,
    model: state?.model ?? null,
    effort: state?.effort ?? null,
    startedAt: state?.firstAt ?? null,
    endedAt: facts.status === "running" || facts.status === "pending" ? null : facts.endedAt ?? state?.lastAt ?? null,
    lastActivityAt: child ? iso(activityMs(child)) : null,
    currentStep: state ? currentStep(state, finished) : null,
    toolCalls,
    turns,
    tokens,
    contextTokens: state ? contextTokens(state) : null,
    resultPreview: facts.result ? displayBlock(facts.result, RESULT_MAX, home) : null,
  };
}

function byActivity(now: number, lastMs: number): RunStatus {
  return lastMs > 0 && now - lastMs < STALE_MS ? "running" : "stopped";
}

/** Last sign of life of an agent, or of a subagent that one of its open Agent calls still waits on. */
function liveMs(child: ChildData, spawned: ReadonlyMap<string, ChildData>, seen: Set<string> = new Set()): number {
  seen.add(child.id);
  let ms = activityMs(child);
  for (const call of child.snapshot.state.agentCalls.values()) {
    if (call.result) continue;
    const sub = spawned.get(call.toolUseId);
    if (sub && !seen.has(sub.id)) ms = Math.max(ms, liveMs(sub, spawned, seen));
  }
  return ms;
}

interface BuiltNode {
  node: AgentNode;
  /** Full result text before display shortening (journal result, notification or Agent tool result). */
  result: string | null;
  /** The transcript the node shows (the latest attempt of a workflow agent). */
  child: ChildData | undefined;
}

interface WorkflowEntry {
  id: string;
  journal: JournalAgent | null;
  child: ChildData | undefined;
  earlier: ChildData[];
}

interface BuiltWorkflow {
  workflow: Workflow;
  nodes: BuiltNode[];
  note: NotificationRecord | null;
}

function buildWorkflow(run: RunData, ctx: Links): BuiltWorkflow {
  const { now, home } = ctx;
  const launch = run.launch;
  const taskId = launch?.result?.taskId ?? null;
  const note = (launch ? ctx.byToolUse.get(launch.toolUseId) : undefined) ?? (taskId ? ctx.notifications.get(taskId) : undefined) ?? null;
  const killed = taskId !== null && ctx.stopped.has(taskId);
  const terminal: TerminalStatus | null = (note ? terminalStatus(note.status) : null) ?? (killed ? "stopped" : null);
  const journalAgents = run.journal ? [...run.journal.state.agents.values()] : [];
  const files = new Map(run.agents.map((child) => [child.id, child]));
  const journalMs = run.journal?.mtimeMs ?? 0;

  // One row per journal key, showing its latest attempt: a retry or a resume runs the key again under a new agent
  // id, and the earlier attempts only add their work to the row's counters.
  const entries: WorkflowEntry[] = [];
  const byKey = new Map<string, WorkflowEntry>();
  for (const agent of journalAgents) {
    const child = files.get(agent.agentId);
    const known = agent.key ? byKey.get(agent.key) : undefined;
    if (known) {
      if (known.child) known.earlier.push(known.child);
      known.id = agent.agentId;
      known.journal = agent;
      known.child = child;
      continue;
    }
    const entry: WorkflowEntry = { id: agent.agentId, journal: agent, child, earlier: [] };
    entries.push(entry);
    if (agent.key) byKey.set(agent.key, entry);
  }
  for (const child of run.agents) if (!run.journal?.state.agents.has(child.id)) entries.push({ id: child.id, journal: null, child, earlier: [] });

  const built = entries.map(({ journal, child, id, earlier }): BuiltNode => {
    let status: RunStatus;
    let result: string | null = null;
    if (journal?.result) {
      status = resultFailed(journal.result.value) ? "failed" : "done";
      result = resultString(journal.result.value);
    } else if (journal?.failed) status = "failed";
    else if (terminal) status = "stopped";
    else status = byActivity(now, child ? liveMs(child, ctx.spawned) : journalMs);
    const meta = child?.meta ?? null;
    const node = agentNode(child, {
      kind: "workflow-agent",
      id,
      label: journal?.label ?? meta?.description ?? id,
      agentType: meta?.agentType ?? "workflow-subagent",
      phase: journal?.phase ?? meta?.workflowPhase ?? null,
      depth: meta?.spawnDepth ?? 1,
      background: false,
      status,
      endedAt: null,
      result,
    }, home, earlier);
    return { node, result, child };
  });
  const nodes = built.map((entry) => entry.node);

  const meta = run.meta;
  const running = nodes.some((node) => node.status === "running");
  const lastMs = Math.max(journalMs, parseTime(launch?.at), ...run.agents.map(activityMs));
  const status: RunStatus = terminal ?? (running || (lastMs > 0 && now - lastMs < STALE_MS) ? "running" : "stopped");

  // Phases: declared order, then phases seen only in the journal, then agents with no phase.
  const order: string[] = [];
  const details = new Map<string, string | null>();
  for (const phase of meta?.phases ?? []) {
    if (!details.has(phase.title)) {
      order.push(phase.title);
      details.set(phase.title, phase.detail);
    }
  }
  const raw = entries.map((entry) => entry.journal?.phase ?? entry.child?.meta?.workflowPhase ?? null);
  for (const phase of raw) if (phase !== null && !details.has(phase)) {
    order.push(phase);
    details.set(phase, null);
  }
  if (raw.some((phase) => phase === null)) order.push(NO_PHASE);
  const phases: Phase[] = order.map((title) => {
    const agents = nodes.filter((_, index) => (raw[index] ?? NO_PHASE) === title);
    let phaseStatus: RunStatus;
    // A phase no agent ran in: still ahead while the run goes on, skipped (unknown) by a run that completed.
    if (!agents.length) phaseStatus = status === "running" ? "pending" : status === "done" ? "unknown" : "stopped";
    else if (agents.some((agent) => agent.status === "running")) phaseStatus = "running";
    else if (agents.some((agent) => agent.status === "failed")) phaseStatus = "failed";
    else if (agents.some((agent) => agent.status === "stopped")) phaseStatus = "stopped";
    else phaseStatus = "done";
    const detail = details.get(title) ?? null;
    return { title: displayLine(title, 120, home), detail: detail ? displayBlock(detail, 400, home) : null, status: phaseStatus, agents };
  });

  const tokens = zero();
  for (const node of nodes) addTokens(tokens, node.tokens);
  const startedAt = launch?.at ?? nodes.map((node) => node.startedAt).filter((at): at is string => at !== null).sort()[0] ?? iso(run.journal?.birthtimeMs ?? 0);
  const endedAt = status === "running" ? null : terminal ? note?.at ?? iso(lastMs) : iso(lastMs);
  const name = meta?.name ?? run.scriptName ?? launch?.result?.workflowName ?? launch?.inputName ?? run.runId;
  return {
    workflow: {
      runId: run.runId,
      taskId,
      name: displayLine(name, 160, home) || run.runId,
      description: meta?.description ? displayBlock(meta.description, 400, home) : null,
      status,
      startedAt,
      endedAt,
      phases,
      agentCounts: countNodes(nodes),
      tokens,
      resultPreview: note?.result ? displayBlock(note.result, RESULT_MAX, home) : null,
    },
    nodes: built,
    note,
  };
}

function buildSubagent(child: ChildData, ctx: Links): BuiltNode {
  const meta = child.meta;
  const call = (meta?.toolUseId ? ctx.calls.get(meta.toolUseId) : undefined) ?? ctx.callsByAgent.get(child.id) ?? null;
  const note = ctx.notifications.get(child.id) ?? (call ? ctx.byToolUse.get(call.toolUseId) : undefined) ?? null;
  const state = child.snapshot.state;
  const terminal = note ? terminalStatus(note.status) : null;
  let status: RunStatus;
  let endedAt: string | null = null;
  if (terminal) {
    status = terminal;
    endedAt = note?.at ?? null;
  } else if (call?.result && !call.result.launchAck) {
    status = call.result.isError ? "failed" : "done";
    endedAt = call.result.at;
  } else if (ctx.stopped.has(child.id)) {
    status = "stopped";
    endedAt = ctx.stopped.get(child.id) ?? null;
  } else status = byActivity(ctx.now, liveMs(child, ctx.spawned));
  // Since Claude Code 2.1.299 the notification and the Agent result only point at the SubagentHandback report.
  const callText = call?.result && !call.result.launchAck ? call.result.text : null;
  const result = reportText(note?.result) ?? state.handback ?? reportText(callText) ?? (status === "done" ? state.lastText : null);
  const node = agentNode(child, {
    kind: "subagent",
    id: child.id,
    label: meta?.description ?? call?.description ?? (state.prompt ? firstLine(state.prompt) : child.id),
    agentType: meta?.agentType ?? call?.subagentType ?? null,
    phase: null,
    depth: meta?.spawnDepth ?? 1,
    background: meta?.requestShape === "background" || call?.background === true,
    status,
    endedAt,
    result,
  }, ctx.home);
  return { node, result, child };
}

function newestFirst<T>(items: T[], at: (item: T) => string | null): T[] {
  return items.sort((a, b) => parseTime(at(b)) - parseTime(at(a)));
}

function guessKind(summary: string | null): BackgroundTask["kind"] {
  if (!summary) return "other";
  if (/^Background command/i.test(summary)) return "shell";
  if (/workflow/i.test(summary)) return "workflow";
  if (/^Agent\b/i.test(summary)) return "agent";
  return "other";
}

function buildTasks(data: SessionData, ctx: Links, workflows: BuiltWorkflow[], subagents: BuiltNode[]): BackgroundTask[] {
  const { now, home } = ctx;
  const tasks: BackgroundTask[] = [];
  const claimed = new Set<string>();
  const summary = (note: NotificationRecord | null | undefined): string | null => (note?.summary ? displayLine(note.summary, 200, home) : null);
  const main = data.main.state;
  // Background shells of the main session and of its agents: their notifications all reach the main transcript.
  const transcripts = [main, ...data.subagents.map((child) => child.snapshot.state), ...data.runs.flatMap((run) => run.agents.map((child) => child.snapshot.state))];
  // A quiet background shell (a dev server that logs nothing) is not stopped while the agent that started it runs.
  // One moved to the background after its timeout dies with the turn that moved it, so it does not get this.
  const runningOwners = new Set<TranscriptState>();
  if (data.record.lastStatus === "running") runningOwners.add(main);
  for (const entry of [...subagents, ...workflows.flatMap((workflow) => workflow.nodes)]) {
    if (entry.node.status === "running" && entry.child) runningOwners.add(entry.child.snapshot.state);
  }

  for (const state of transcripts) for (const shell of state.shells.values()) {
    if (shell.taskId && claimed.has(shell.taskId)) continue;
    const note = (shell.taskId ? ctx.notifications.get(shell.taskId) : undefined) ?? ctx.byToolUse.get(shell.toolUseId) ?? null;
    const stoppedAt = shell.taskId ? ctx.stopped.get(shell.taskId) : undefined;
    const terminal = note ? terminalStatus(note.status) : null;
    const lastMs = shell.requested && runningOwners.has(state) ? now : Math.max(parseTime(shell.at), data.shellActivity.get(shell.toolUseId) ?? 0);
    const status: RunStatus = terminal ?? (stoppedAt !== undefined ? "stopped" : byActivity(now, lastMs));
    if (shell.taskId) claimed.add(shell.taskId);
    tasks.push({
      id: shell.taskId ?? shell.toolUseId,
      kind: "shell",
      title: shell.title,
      status,
      startedAt: shell.at,
      endedAt: terminal ? note?.at ?? null : stoppedAt ?? (status === "stopped" ? iso(data.shellActivity.get(shell.toolUseId) ?? 0) : null),
      summary: summary(note),
    });
  }

  const nodesById = new Map(subagents.map((entry) => [entry.node.id, entry.node]));
  for (const call of main.agentCalls.values()) {
    if (!call.background) continue;
    const agentId = call.result?.agentId ?? null;
    const node = agentId ? nodesById.get(agentId) : undefined;
    const note = (agentId ? ctx.notifications.get(agentId) : undefined) ?? ctx.byToolUse.get(call.toolUseId) ?? null;
    if (agentId) claimed.add(agentId);
    if (note) claimed.add(note.taskId);
    const status: RunStatus = node?.status ?? (note ? terminalStatus(note.status) ?? "unknown" : byActivity(now, parseTime(call.at)));
    tasks.push({
      id: agentId ?? call.toolUseId,
      kind: "agent",
      title: displayLine(call.description ?? node?.label ?? "Background agent", 200, home),
      status,
      startedAt: call.at,
      endedAt: node?.endedAt ?? note?.at ?? null,
      summary: summary(note),
    });
  }

  for (const built of workflows) {
    const { workflow, note } = built;
    if (workflow.taskId) claimed.add(workflow.taskId);
    if (note) claimed.add(note.taskId);
    tasks.push({
      id: workflow.taskId ?? workflow.runId,
      kind: "workflow",
      title: workflow.name,
      status: workflow.status,
      startedAt: workflow.startedAt,
      endedAt: workflow.endedAt,
      summary: summary(note),
    });
  }

  // Notifications of the main session nothing above accounts for (a call trimmed away, a tool this parser does not know).
  for (const note of main.notifications.values()) {
    if (claimed.has(note.taskId)) continue;
    tasks.push({
      id: note.taskId,
      kind: guessKind(note.summary),
      title: note.summary ? displayLine(note.summary, 200, home) : note.taskId,
      status: terminalStatus(note.status) ?? "unknown",
      startedAt: null,
      endedAt: note.at,
      summary: summary(note),
    });
  }
  return newestFirst(tasks, (task) => task.startedAt ?? task.endedAt);
}

export interface BuiltTree {
  tree: SessionTree;
  /** Every child node by id (`<runId>/<agentId>` for workflow agents), for agent.steps. */
  nodes: Map<string, BuiltNode>;
}

export function buildTree(data: SessionData, now: number, home: string): BuiltTree {
  const ctx = links(data, now, home);
  const built = data.runs.map((run) => ({ run, ...buildWorkflow(run, ctx) }));
  const nodes: BuiltTree["nodes"] = new Map();
  const builtSubagents = data.subagents.map((child) => buildSubagent(child, ctx));
  for (const entry of builtSubagents) nodes.set(entry.node.id, entry);
  for (const { run, nodes: workflowNodes } of built) for (const entry of workflowNodes) nodes.set(`${run.runId}/${entry.node.id}`, entry);
  const subagents = builtSubagents.map((entry) => entry.node);

  const main = data.main.state;
  const totalTokens = { ...main.tokens };
  const everyNode = [...built.flatMap((entry) => entry.nodes.map((item) => item.node)), ...subagents];
  for (const node of everyNode) addTokens(totalTokens, node.tokens);
  const workflows = newestFirst(built.map((entry) => entry.workflow), (workflow) => workflow.startedAt);
  const tree: SessionTree = {
    found: true,
    reason: null,
    sessionId: data.sessionId,
    cwd: data.record.cwd,
    model: data.record.model ?? main.model,
    main: {
      tokens: { ...main.tokens },
      contextTokens: contextTokens(main),
      turns: main.messages.size,
      toolCalls: main.toolCalls,
      currentStep: currentStep(main, false),
      lastActivityAt: latest(main.lastAt, iso(data.main.mtimeMs)),
    },
    totalTokens,
    workflows,
    subagents: newestFirst(subagents, (node) => node.startedAt),
    tasks: buildTasks(data, ctx, built, builtSubagents),
    todos: main.todos.map((todo) => ({ ...todo })),
    counts: countNodes(everyNode),
    generatedAt: new Date(now).toISOString(),
  };
  return { tree, nodes };
}

const headline = (step: Step | null): Step | null => (step ? { ...step, detail: null, resultPreview: null } : null);
const headlineNode = (node: AgentNode): AgentNode => ({ ...node, currentStep: headline(node.currentStep) });

/**
 * The tree as tree.get sends it: the panel shows only the title of each current step and polls every 2 s, so the
 * step input and result previews stay with agent.steps.
 */
export function panelTree(tree: SessionTree): SessionTree {
  return {
    ...tree,
    main: tree.main ? { ...tree.main, currentStep: headline(tree.main.currentStep) } : null,
    workflows: tree.workflows.map((workflow) => ({ ...workflow, phases: workflow.phases.map((phase) => ({ ...phase, agents: phase.agents.map(headlineNode) })) })),
    subagents: tree.subagents.map(headlineNode),
  };
}

export function notFoundTree(reason: string, now: number, cwd: string | null = null): SessionTree {
  return {
    found: false,
    reason,
    sessionId: null,
    cwd,
    model: null,
    main: null,
    totalTokens: zero(),
    workflows: [],
    subagents: [],
    tasks: [],
    todos: [],
    counts: { total: 0, running: 0, done: 0, failed: 0 },
    generatedAt: new Date(now).toISOString(),
  };
}

function stepsOf(state: TranscriptState, limit: number, finished: boolean): Pick<AgentSteps, "steps" | "truncated"> {
  const retained = state.steps.slice(-limit);
  return { steps: retained.map((step) => toStep(step, finished)), truncated: state.droppedSteps + state.steps.length > retained.length };
}

export function buildSteps(data: SessionData, built: BuiltTree, childId: string, runId: string | null, limit: number, home: string): AgentSteps {
  const missing: AgentSteps = { found: false, node: null, steps: [], truncated: false, finalText: null, prompt: null };
  if (childId === "main") {
    const state = data.main.state;
    const idle = data.record.lastStatus !== "running" && state.lastStopReason === "end_turn";
    return { found: true, node: null, ...stepsOf(state, limit, false), finalText: idle ? state.lastText : null, prompt: state.prompt };
  }
  const entry = built.nodes.get(runId === null ? childId : `${runId}/${childId}`);
  if (!entry) return missing;
  const state = entry.child?.snapshot.state;
  if (!state) return { ...missing, found: true, node: entry.node };
  const finished = entry.node.status === "done" || entry.node.status === "failed" || entry.node.status === "stopped";
  const finalText = finished ? (entry.result ? displayBlock(entry.result, LONG_TEXT_MAX, home) : state.lastText) : null;
  return { found: true, node: entry.node, ...stepsOf(state, limit, entry.node.status === "done"), finalText, prompt: state.prompt };
}

export function summarise(tree: SessionTree, base: Pick<SessionSummary, "agentId" | "title" | "cwd" | "workspaceId" | "paseoStatus" | "lastActivityAt">): SessionSummary {
  const activity = [base.lastActivityAt, tree.main?.lastActivityAt ?? null, ...tree.subagents.map((node) => node.lastActivityAt), ...tree.workflows.flatMap((workflow) => workflow.phases.flatMap((phase) => phase.agents.map((node) => node.lastActivityAt)))];
  return {
    ...base,
    lastActivityAt: latest(...activity),
    counts: tree.counts,
    workflowsRunning: tree.workflows.filter((workflow) => workflow.status === "running").length,
    tasksRunning: tree.tasks.filter((task) => task.status === "running").length,
    totalTokens: tree.totalTokens,
  };
}
