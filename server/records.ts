import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { obj, str } from "./format";
import { safeId } from "./env";
import { fileGate } from "./jsonl";

// Paseo agent records: $PASEO_HOME/agents/<cwd-dir>/<agentId>.json, cached by mtime and size.

export interface AgentRecord {
  id: string;
  provider: string | null;
  cwd: string | null;
  workspaceId: string | null;
  title: string | null;
  lastStatus: string | null;
  lastActivityAt: string | null;
  sessionId: string | null;
  model: string | null;
}

interface CachedRecord {
  mtimeMs: number;
  size: number;
  record: AgentRecord | null;
}

export function parseRecord(raw: unknown): AgentRecord | null {
  const data = obj(raw);
  const id = str(data?.id);
  if (!data || !id) return null;
  const persistence = obj(data.persistence);
  const runtime = obj(data.runtimeInfo);
  const config = obj(data.config);
  return {
    id,
    provider: str(data.provider) ?? str(persistence?.provider) ?? str(runtime?.provider),
    cwd: str(data.cwd),
    workspaceId: str(data.workspaceId),
    title: str(data.title),
    lastStatus: str(data.lastStatus),
    lastActivityAt: str(data.lastActivityAt) ?? str(data.updatedAt),
    sessionId: str(persistence?.sessionId) ?? str(runtime?.sessionId),
    model: str(runtime?.model) ?? str(config?.model),
  };
}

export class RecordStore {
  private readonly files = new Map<string, CachedRecord>();
  private readonly paths = new Map<string, string>();

  constructor(private readonly paseoHome: string) {}

  private get agentsDir(): string {
    return join(this.paseoHome, "agents");
  }

  private async load(path: string): Promise<AgentRecord | null> {
    let info;
    try {
      info = await stat(path);
    } catch {
      this.files.delete(path);
      return null;
    }
    const cached = this.files.get(path);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.record;
    let record: AgentRecord | null = null;
    try {
      record = parseRecord(JSON.parse(await fileGate.run(() => readFile(path, "utf8"))));
    } catch {
      // Being rewritten or corrupt: keep the last good copy if there is one.
      return cached?.record ?? null;
    }
    this.files.set(path, { mtimeMs: info.mtimeMs, size: info.size, record });
    if (record) this.paths.set(record.id, path);
    return record;
  }

  private async directories(): Promise<string[]> {
    try {
      const entries = await readdir(this.agentsDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => join(this.agentsDir, entry.name));
    } catch {
      return [];
    }
  }

  async get(agentId: string): Promise<AgentRecord | null> {
    if (!safeId(agentId)) return null;
    const known = this.paths.get(agentId);
    if (known) {
      const record = await this.load(known);
      if (record?.id === agentId) return record;
      this.paths.delete(agentId);
    }
    for (const dir of await this.directories()) {
      const path = join(dir, `${agentId}.json`);
      const record = await this.load(path);
      if (record?.id === agentId) return record;
    }
    return null;
  }

  async list(): Promise<AgentRecord[]> {
    const dirs = await this.directories();
    const names = await Promise.all(
      dirs.map(async (dir) => {
        try {
          return (await readdir(dir)).filter((name) => name.endsWith(".json")).map((name) => join(dir, name));
        } catch {
          return [];
        }
      }),
    );
    const paths = names.flat();
    const live = new Set(paths);
    for (const path of this.files.keys()) if (!live.has(path)) this.files.delete(path);
    const records = await Promise.all(paths.map((path) => this.load(path)));
    return records.filter((record): record is AgentRecord => record !== null);
  }
}
