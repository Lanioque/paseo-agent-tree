import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { runsOverviewRpc } from "../shared/contract";
import { isForeground, subscribeForeground } from "./foreground";
import { runningAgents, type OverviewStore } from "./overview";
import { PANEL_ID, PLUGIN_ICON } from "./ids";
import { RUNS_SINCE_HOURS } from "./queries";

const PILL_POLL_MS = 15_000;

/** Claude Code agents only: the "claude" provider, with or without a "/model" suffix. */
function isClaudeProvider(provider: string): boolean {
  return provider.split("/")[0] === "claude";
}

const pillLabel = (running: number) => (running > 0 ? `Agents · ${running}` : "Agents");

/**
 * One "Agents" pill per Claude agent composer, labelled "Agents · N" while N of its agents run. Every pill reads the
 * same store, fed by one runs.overview poll that runs only while a pill exists and the app is in the foreground.
 */
export function contributeAgentPills(client: PluginClientContext, store: OverviewStore): () => void {
  const pills = new Map<string, { registration: PluginButtonRegistration; label: string }>();
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setInterval> | null = null;
  let reading = false;
  let failing = false;

  async function read() {
    if (reading) return;
    reading = true;
    try {
      store.publish(await client.rpc(runsOverviewRpc, { sinceHours: RUNS_SINCE_HOURS }));
      failing = false;
    } catch (error) {
      // One log per failure streak: the poll retries every 15 s and the labels keep their last value.
      if (!failing && !lifetime.signal.aborted) console.error("[agent-tree] runs.overview failed", error);
      failing = true;
    } finally {
      reading = false;
    }
  }

  function syncPolling() {
    const wanted = !lifetime.signal.aborted && pills.size > 0 && isForeground();
    if (wanted && timer === null) {
      void read();
      timer = setInterval(() => void read(), PILL_POLL_MS);
    } else if (!wanted && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function relabel() {
    const sessions = store.sessions();
    for (const [agentId, pill] of pills) {
      const label = pillLabel(runningAgents(sessions, agentId));
      if (label === pill.label) continue;
      pill.label = label;
      pill.registration.update({ label });
    }
  }

  function remove(agentId: string) {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  }

  function register(agent: { id: string; provider: string; workspaceId?: string | null }) {
    if (lifetime.signal.aborted) return;
    if (!agent.workspaceId || !isClaudeProvider(agent.provider)) {
      remove(agent.id);
      return;
    }
    if (pills.has(agent.id)) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    const label = pillLabel(runningAgents(store.sessions(), agentId));
    const registration = client.addComposerPill({
      id: "agents",
      workspaceId,
      agentId,
      button: {
        title: "Open agent tree",
        icon: PLUGIN_ICON,
        label,
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel(PANEL_ID, { workspaceId, agentId, location: "explorer" });
          },
        },
      },
    });
    pills.set(agentId, { registration, label });
  }

  function removeAll() {
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  }

  const stopStore = store.subscribe(relabel);
  const stopForeground = subscribeForeground(syncPolling);

  // An owned list subscription delivers existing agents, then updates, and a fresh snapshot after a reconnect.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
          syncPolling();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") register(update.agent);
          else remove(update.agentId);
          syncPolling();
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error("[agent-tree] agent observation failed", error);
    });

  return () => {
    lifetime.abort();
    stopStore();
    stopForeground();
    syncPolling();
    removeAll();
  };
}
