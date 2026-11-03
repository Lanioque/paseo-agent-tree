import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Token counters summed over every API message of one agent (streamed copies of a message count once). */
export const tokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
});
export type Tokens = z.infer<typeof tokensSchema>;

/**
 * pending: declared (workflow phase) but not started. running: no terminal event yet and recent activity.
 * done / failed: a terminal event says so. stopped: no terminal event and no activity for a long time,
 * or its parent run ended without it. unknown: not enough data.
 */
export const runStatusSchema = z.enum(["pending", "running", "done", "failed", "stopped", "unknown"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** One unit of work in an agent transcript: a tool call, or a text/thinking block. */
export const stepSchema = z.object({
  /** tool_use id, or a synthetic id for text/thinking blocks. */
  id: z.string(),
  /** ISO timestamp the step started. */
  at: z.string(),
  /** ISO timestamp its result arrived; null while running or for text/thinking. */
  endedAt: z.string().nullable(),
  kind: z.enum(["tool", "text", "thinking"]),
  /** Tool name (Bash, Read, Edit, WebFetch, mcp__server__tool, Agent, Workflow…); null for text/thinking. */
  tool: z.string().nullable(),
  /** One-line human summary: Bash description or command, file path, URL, query, first line of text. Max ~160 chars. */
  title: z.string(),
  /** Longer input preview (pretty, truncated ~800 chars); null when title says it all. */
  detail: z.string().nullable(),
  status: z.enum(["running", "ok", "error"]),
  /** First ~600 chars of the tool result; null when none yet. */
  resultPreview: z.string().nullable(),
});
export type Step = z.infer<typeof stepSchema>;

export const agentNodeSchema = z.object({
  /** Claude Code agent id (the agent-<id>.jsonl name). */
  id: z.string(),
  kind: z.enum(["workflow-agent", "subagent"]),
  /** Workflow label (e.g. "audit:ci-history") or the Agent tool description. */
  label: z.string(),
  /** meta.json agentType: workflow-subagent, general-purpose, Explore… */
  agentType: z.string().nullable(),
  /** Workflow phase title, null for plain subagents. */
  phase: z.string().nullable(),
  /** meta.json spawnDepth (1 = spawned by the main session). */
  depth: z.number(),
  /** Agent tool run_in_background / requestShape "background". */
  background: z.boolean(),
  status: runStatusSchema,
  model: z.string().nullable(),
  effort: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  /** The running step if any, else the last step. */
  currentStep: stepSchema.nullable(),
  toolCalls: z.number(),
  /** Distinct assistant API messages. */
  turns: z.number(),
  tokens: tokensSchema,
  /** Context size of the latest API call: input + cacheRead + cacheWrite. */
  contextTokens: z.number().nullable(),
  /** First ~600 chars of the agent's final result (journal result or last assistant text). */
  resultPreview: z.string().nullable(),
});
export type AgentNode = z.infer<typeof agentNodeSchema>;

export const phaseSchema = z.object({
  title: z.string(),
  detail: z.string().nullable(),
  /** Status derived from its agents: pending when none started, running when any runs, else done/failed. */
  status: runStatusSchema,
  agents: z.array(agentNodeSchema),
});
export type Phase = z.infer<typeof phaseSchema>;

export const countsSchema = z.object({
  total: z.number(),
  running: z.number(),
  done: z.number(),
  failed: z.number(),
});
export type Counts = z.infer<typeof countsSchema>;

export const workflowSchema = z.object({
  /** wf_xxxxxxxx-xxx */
  runId: z.string(),
  /** Background task id from the Workflow tool result, used by task notifications. */
  taskId: z.string().nullable(),
  /** meta.name, else the script file name. */
  name: z.string(),
  /** meta.description. */
  description: z.string().nullable(),
  status: runStatusSchema,
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** meta.phases order first, then phases only seen in the journal; agents without a phase go under "(no phase)". */
  phases: z.array(phaseSchema),
  agentCounts: countsSchema,
  tokens: tokensSchema,
  /** First ~600 chars of the task notification result. */
  resultPreview: z.string().nullable(),
});
export type Workflow = z.infer<typeof workflowSchema>;

/** Background shell commands and other run_in_background tasks of the main session. */
export const backgroundTaskSchema = z.object({
  id: z.string(),
  kind: z.enum(["shell", "agent", "workflow", "other"]),
  title: z.string(),
  status: runStatusSchema,
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** Notification summary, e.g. 'completed (exit code 0)'. */
  summary: z.string().nullable(),
});
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;

/** Latest todo list of the main session (TodoWrite, or TaskCreate/TaskUpdate). */
export const todoSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string().nullable(),
});
export type Todo = z.infer<typeof todoSchema>;

export const mainSessionSchema = z.object({
  tokens: tokensSchema,
  contextTokens: z.number().nullable(),
  turns: z.number(),
  toolCalls: z.number(),
  /** What the main agent is doing now (running step) or did last. */
  currentStep: stepSchema.nullable(),
  lastActivityAt: z.string().nullable(),
});
export type MainSession = z.infer<typeof mainSessionSchema>;

export const sessionTreeSchema = z.object({
  /** False when the agent is not a Claude Code agent or its transcript cannot be found. */
  found: z.boolean(),
  /** Why found is false, in plain words. */
  reason: z.string().nullable(),
  sessionId: z.string().nullable(),
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  main: mainSessionSchema.nullable(),
  /** Main session + every subagent and workflow agent. */
  totalTokens: tokensSchema,
  /** Newest first. */
  workflows: z.array(workflowSchema),
  /** Agent tool subagents (not workflow agents), newest first. */
  subagents: z.array(agentNodeSchema),
  /** Newest first. */
  tasks: z.array(backgroundTaskSchema),
  todos: z.array(todoSchema),
  /** Over workflow agents + subagents. */
  counts: countsSchema,
  generatedAt: z.string(),
});
export type SessionTree = z.infer<typeof sessionTreeSchema>;

/** Tree of one Paseo agent's Claude Code session. */
export const sessionTreeRpc = defineRpc({
  name: "tree.get",
  input: z.object({ agentId: z.string() }),
  output: sessionTreeSchema,
});

export const agentStepsSchema = z.object({
  found: z.boolean(),
  node: agentNodeSchema.nullable(),
  /** Oldest first, at most the last `limit` steps. */
  steps: z.array(stepSchema),
  /** True when older steps were dropped. */
  truncated: z.boolean(),
  /** Final assistant text (~4000 chars) when the agent finished. */
  finalText: z.string().nullable(),
  /** The task prompt the agent received (~4000 chars). */
  prompt: z.string().nullable(),
});
export type AgentSteps = z.infer<typeof agentStepsSchema>;

/** Step list of one child agent. childId "main" means the main session itself. runId is set for workflow agents. */
export const agentStepsRpc = defineRpc({
  name: "agent.steps",
  input: z.object({
    agentId: z.string(),
    childId: z.string(),
    runId: z.string().nullable(),
    limit: z.number().int().min(1).max(1000),
  }),
  output: agentStepsSchema,
});

export const sessionSummarySchema = z.object({
  /** Paseo agent id. */
  agentId: z.string(),
  title: z.string().nullable(),
  cwd: z.string(),
  workspaceId: z.string().nullable(),
  /** Paseo lastStatus of the agent record. */
  paseoStatus: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  counts: countsSchema,
  workflowsRunning: z.number(),
  tasksRunning: z.number(),
  totalTokens: tokensSchema,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/** Every Claude Code Paseo agent active in the last `sinceHours` hours, most recent first. */
export const runsOverviewRpc = defineRpc({
  name: "runs.overview",
  input: z.object({ sinceHours: z.number().min(1).max(24 * 14) }),
  output: z.object({ sessions: z.array(sessionSummarySchema), generatedAt: z.string() }),
});
