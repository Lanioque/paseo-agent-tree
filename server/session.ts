import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Env, projectDirName, safeId } from "./env";
import { obj, str } from "./format";
import { type FileSnapshot, fileGate, Gate, JsonlCache } from "./jsonl";
import { type JournalState, journalReducer } from "./journal";
import { readWorkflowMeta, type WorkflowMeta } from "./meta-literal";
import { type AgentRecord, RecordStore } from "./records";
import { type TranscriptState, transcriptReducer, type WorkflowLaunch } from "./transcript";

// Finds a Paseo agent's Claude Code session on disk and reads every file of it through the incremental caches:
// main transcript, subagents/agent-*.jsonl (+ .meta.json), subagents/workflows/<runId>/{journal,agent-*}.jsonl.

export interface SubagentMeta {
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  spawnDepth: number | null;
  requestShape: string | null;
  workflowPhase: string | null;
}

export interface ChildData {
  id: string;
  meta: SubagentMeta | null;
  snapshot: FileSnapshot<TranscriptState>;
}

export interface RunData {
  runId: string;
  journal: FileSnapshot<JournalState> | null;
  agents: ChildData[];
  launch: WorkflowLaunch | null;
  meta: WorkflowMeta | null;
  /** <name> of the script copy workflows/scripts/<name>-<runId>.js. */
  scriptName: string | null;
}

export interface SessionData {
  record: AgentRecord;
  sessionId: string;
  main: FileSnapshot<TranscriptState>;
  subagents: ChildData[];
  runs: RunData[];
  /** Background shell tool_use id → mtime of its output file, for shells still without a notification. */
  shellActivity: Map<string, number>;
}

export type SessionLoad = { ok: true; data: SessionData } | { ok: false; reason: string };

const AGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;
const MISSING_RETRY_MS = 60_000;
/**
 * A cold overview reads more than a gigabyte: it gets a few reads of its own so that it never fills the panel's
 * gate, and leaves libuv threads free for the panel's stat and read calls.
 */
const overviewGate = new Gate(3);

function parseMeta(raw: unknown): SubagentMeta | null {
  const data = obj(raw);
  if (!data) return null;
  return {
    agentType: str(data.agentType),
    description: str(data.description),
    toolUseId: str(data.toolUseId),
    spawnDepth: typeof data.spawnDepth === "number" ? data.spawnDepth : null,
    requestShape: str(data.requestShape),
    workflowPhase: str(data.workflowPhase),
  };
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** full: step lists and texts (tree.get, agent.steps). summary: counters and statuses only (runs.overview). */
export type ReadMode = "full" | "summary";

interface TranscriptCaches {
  mains: JsonlCache<TranscriptState>;
  children: JsonlCache<TranscriptState>;
  gate: Gate;
}

export class SessionStore {
  readonly records: RecordStore;
  private readonly caches: Record<ReadMode, TranscriptCaches>;
  private readonly journals = new JsonlCache(journalReducer, { maxFiles: 400, maxWeight: 16 * 1024 * 1024 });
  /** meta.json files are written once when the agent starts: a parsed copy is kept for good. */
  private readonly metas = new Map<string, SubagentMeta>();
  private readonly scripts = new Map<string, { mtimeMs: number; meta: WorkflowMeta | null }>();
  private readonly transcripts = new Map<string, string>();
  /** Sessions whose transcript was not found, and when: the project scan is not repeated on every poll. */
  private readonly missing = new Map<string, number>();

  constructor(readonly env: Env) {
    this.records = new RecordStore(env.paseoHome);
    const reducer = (skipSidechain: boolean, keepSteps: boolean) => transcriptReducer({ home: env.home, skipSidechain, keepSteps });
    this.caches = {
      full: {
        // Retained characters (steps are capped per agent): one large session needs ~15 M, a dozen open ones fit.
        mains: new JsonlCache(reducer(true, true), { maxFiles: 200, maxWeight: 24 * 1024 * 1024 }),
        children: new JsonlCache(reducer(false, true), { maxFiles: 1500, maxWeight: 64 * 1024 * 1024 }),
        gate: fileGate,
      },
      // Summary states hold no steps: small enough to keep every session of a two-week overview.
      summary: {
        mains: new JsonlCache(reducer(true, false), { maxFiles: 2000, maxWeight: 32 * 1024 * 1024 }, overviewGate),
        children: new JsonlCache(reducer(false, false), { maxFiles: 8000, maxWeight: 64 * 1024 * 1024 }, overviewGate),
        gate: overviewGate,
      },
    };
  }

  /** <config>/projects/<projDir>/<sessionId>.jsonl, else any project directory holding that session. */
  private async transcriptPath(cwd: string | null, sessionId: string): Promise<string | null> {
    const known = this.transcripts.get(sessionId);
    if (known && (await isFile(known))) return known;
    const name = `${sessionId}.jsonl`;
    if (cwd) {
      for (const dir of this.env.claudeDirs) {
        const path = join(dir, "projects", projectDirName(cwd), name);
        if (await isFile(path)) {
          this.transcripts.set(sessionId, path);
          return path;
        }
      }
    }
    const missedAt = this.missing.get(sessionId);
    if (missedAt !== undefined && Date.now() - missedAt < MISSING_RETRY_MS) return null;
    for (const dir of this.env.claudeDirs) {
      const projects = join(dir, "projects");
      for (const project of await listDir(projects)) {
        const path = join(projects, project, name);
        if (await isFile(path)) {
          this.transcripts.set(sessionId, path);
          this.missing.delete(sessionId);
          return path;
        }
      }
    }
    this.missing.set(sessionId, Date.now());
    return null;
  }

  async load(agentId: string, mode: ReadMode = "full"): Promise<SessionLoad> {
    const record = await this.records.get(agentId);
    if (!record) return { ok: false, reason: `No Paseo agent record found for ${agentId.slice(0, 80)}.` };
    return this.loadRecord(record, mode);
  }

  async loadRecord(record: AgentRecord, mode: ReadMode = "full"): Promise<SessionLoad> {
    const caches = this.caches[mode];
    if (record.provider !== "claude") {
      return { ok: false, reason: `This agent runs on ${record.provider ?? "an unknown provider"}; the agent tree reads Claude Code sessions only.` };
    }
    const sessionId = record.sessionId;
    if (!sessionId || !safeId(sessionId)) return { ok: false, reason: "The agent has no Claude Code session yet." };
    const transcriptPath = await this.transcriptPath(record.cwd, sessionId);
    const main = transcriptPath ? await caches.mains.read(transcriptPath) : null;
    if (!transcriptPath || !main) {
      this.transcripts.delete(sessionId);
      return { ok: false, reason: `Claude Code transcript ${sessionId}.jsonl was not found.` };
    }
    const sessionDir = transcriptPath.slice(0, -".jsonl".length);
    const subagentsDir = join(sessionDir, "subagents");
    const [subagents, runDirs, scriptFiles] = await Promise.all([
      this.readChildren(caches, subagentsDir),
      listDir(join(subagentsDir, "workflows")),
      listDir(join(sessionDir, "workflows", "scripts")),
    ]);
    const launches = new Map<string, WorkflowLaunch>();
    for (const state of [main.state, ...subagents.map((child) => child.snapshot.state)]) {
      for (const launch of state.workflowLaunches.values()) {
        const runId = launch.result?.runId;
        if (runId && safeId(runId)) launches.set(runId, launch);
      }
    }
    const runIds = new Set([...runDirs.filter(safeId), ...launches.keys()]);
    const runs = await Promise.all(
      [...runIds].map(async (runId): Promise<RunData> => {
        const launch = launches.get(runId) ?? null;
        const declared = launch?.result?.transcriptDir;
        const dir = declared && basename(declared) === runId ? declared : join(subagentsDir, "workflows", runId);
        const script = scriptFiles.find((file) => file.endsWith(`-${runId}.js`)) ?? null;
        const scriptPath = launch?.result?.scriptPath ?? (script ? join(sessionDir, "workflows", "scripts", script) : null);
        const [journal, agents, meta] = await Promise.all([
          this.journals.read(join(dir, "journal.jsonl")),
          this.readChildren(caches, dir),
          launch?.meta ? Promise.resolve(launch.meta) : this.scriptMeta(launch?.inputScriptPath ?? scriptPath, caches.gate),
        ]);
        const scriptBase = scriptPath ? basename(scriptPath) : script;
        const scriptName = scriptBase?.endsWith(`-${runId}.js`) ? scriptBase.slice(0, -`-${runId}.js`.length) : null;
        return { runId, journal, agents, launch, meta, scriptName };
      }),
    );
    const states = [main.state, ...subagents.map((child) => child.snapshot.state), ...runs.flatMap((run) => run.agents.map((child) => child.snapshot.state))];
    const shellActivity = await this.shellActivity(states);
    return { ok: true, data: { record, sessionId, main, subagents, runs, shellActivity } };
  }

  /** Last write to the output file of each background shell that has not reported its end. */
  private async shellActivity(states: readonly TranscriptState[]): Promise<Map<string, number>> {
    const reported = new Set(states.flatMap((state) => [...state.notifications.keys(), ...state.stopped.keys()]));
    const shells = states.flatMap((state) => [...state.shells.values()]).filter((shell) => shell.outputFile && !(shell.taskId && reported.has(shell.taskId)));
    const activity = new Map<string, number>();
    await Promise.all(
      shells.map(async (shell) => {
        try {
          if (shell.outputFile) activity.set(shell.toolUseId, (await stat(shell.outputFile)).mtimeMs);
        } catch {
          // Output file gone (temp dir cleaned): no activity to report.
        }
      }),
    );
    return activity;
  }

  /** agent-<id>.jsonl files of a directory with their meta.json. */
  private async readChildren(caches: TranscriptCaches, dir: string): Promise<ChildData[]> {
    const files = (await listDir(dir)).map((name) => AGENT_FILE.exec(name)?.[1]).filter((id): id is string => id !== undefined);
    const children = await Promise.all(
      files.map(async (id): Promise<ChildData | null> => {
        const path = join(dir, `agent-${id}.jsonl`);
        const [snapshot, meta] = await Promise.all([caches.children.read(path), this.meta(join(dir, `agent-${id}.meta.json`), caches.gate)]);
        return snapshot ? { id, meta, snapshot } : null;
      }),
    );
    return children.filter((child): child is ChildData => child !== null);
  }

  private async meta(path: string, gate: Gate): Promise<SubagentMeta | null> {
    const cached = this.metas.get(path);
    if (cached) return cached;
    try {
      const meta = parseMeta(JSON.parse(await gate.run(() => readFile(path, "utf8"))));
      if (meta) this.metas.set(path, meta);
      return meta;
    } catch {
      return null;
    }
  }

  private async scriptMeta(path: string | null, gate: Gate): Promise<WorkflowMeta | null> {
    if (!path) return null;
    try {
      const info = await stat(path);
      const cached = this.scripts.get(path);
      if (cached && cached.mtimeMs === info.mtimeMs) return cached.meta;
      // A script is a few tens of KB; anything far larger is not a workflow script.
      const meta = info.size < 2 * 1024 * 1024 ? readWorkflowMeta(await gate.run(() => readFile(path, "utf8"))) : null;
      this.scripts.set(path, { mtimeMs: info.mtimeMs, meta });
      return meta;
    } catch {
      return null;
    }
  }
}
