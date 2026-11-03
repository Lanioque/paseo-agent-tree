import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { agentStepsRpc, runsOverviewRpc, sessionTreeRpc } from "../shared/contract";
import { displayLine } from "./mask";
import type { AgentRecord } from "./records";
import type { ReadMode, SessionStore } from "./session";
import { buildSteps, buildTree, notFoundTree, panelTree, summarise } from "./tree";

// The three RPC handlers over one SessionStore, so that the tree, the step lists and the overview share the
// incremental caches.

const OVERVIEW_LIMIT = 40;
/** Sessions parsed at once by the overview: a cold start reads many files, a few at a time keeps memory flat. */
const OVERVIEW_CONCURRENCY = 4;

async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      results[index] = await work(item);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface Handlers {
  tree(input: RpcInput<typeof sessionTreeRpc>): Promise<RpcOutput<typeof sessionTreeRpc>>;
  steps(input: RpcInput<typeof agentStepsRpc>): Promise<RpcOutput<typeof agentStepsRpc>>;
  overview(input: RpcInput<typeof runsOverviewRpc>): Promise<RpcOutput<typeof runsOverviewRpc>>;
}

export function createHandlers(store: SessionStore, clock: () => number = Date.now): Handlers {
  const home = store.env.home;

  async function treeFor(record: AgentRecord, mode: ReadMode): Promise<RpcOutput<typeof sessionTreeRpc>> {
    const now = clock();
    try {
      const load = await store.loadRecord(record, mode);
      return load.ok ? buildTree(load.data, now, home).tree : notFoundTree(load.reason, now, record.cwd);
    } catch (error) {
      // A transcript shape this parser does not expect must not take the whole overview down.
      console.error(`agent-tree: could not read the session of ${record.id}`, error);
      return notFoundTree("This session could not be read; see the plugin logs.", now, record.cwd);
    }
  }

  return {
    async tree({ agentId }) {
      const record = await store.records.get(agentId);
      return record ? panelTree(await treeFor(record, "full")) : notFoundTree(`No Paseo agent record found for ${agentId.slice(0, 80)}.`, clock());
    },

    async steps({ agentId, childId, runId, limit }) {
      const load = await store.load(agentId);
      if (!load.ok) return { found: false, node: null, steps: [], truncated: false, finalText: null, prompt: null };
      const built = buildTree(load.data, clock(), home);
      return buildSteps(load.data, built, childId, runId, limit, home);
    },

    async overview({ sinceHours }) {
      const now = clock();
      const since = now - sinceHours * 3_600_000;
      const records = (await store.records.list())
        .filter((record) => record.provider === "claude" && record.lastActivityAt !== null && Date.parse(record.lastActivityAt) >= since)
        .sort((a, b) => Date.parse(b.lastActivityAt ?? "") - Date.parse(a.lastActivityAt ?? ""))
        .slice(0, OVERVIEW_LIMIT);
      const sessions = await mapLimit(records, OVERVIEW_CONCURRENCY, async (record) =>
        summarise(await treeFor(record, "summary"), {
          agentId: record.id,
          title: record.title ? displayLine(record.title, 200, home) : null,
          cwd: record.cwd ?? "",
          workspaceId: record.workspaceId,
          paseoStatus: record.lastStatus,
          lastActivityAt: record.lastActivityAt,
        }),
      );
      sessions.sort((a, b) => Date.parse(b.lastActivityAt ?? "") - Date.parse(a.lastActivityAt ?? ""));
      return { sessions, generatedAt: new Date(now).toISOString() };
    },
  };
}
