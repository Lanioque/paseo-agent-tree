import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PANEL_ID, PLUGIN_ICON, RUNS_SCREEN_ID } from "./client/ids";
import { createOverviewStore } from "./client/overview";
import { contributeAgentPills } from "./client/pills";
import { createRunsScreen, createRunsSidebarItem } from "./client/runs-screen";
import { AgentTreePanel } from "./client/tree-panel";

export default function contribute(client: PluginClientContext) {
  // Per installation: each host's runs.overview feeds its own pills and sidebar badge.
  const overview = createOverviewStore();
  const removers = [
    // Made for the Explorer (the right sidebar), where every entry point opens it; a workspace tab still works.
    client.addAgentPanel({
      id: PANEL_ID,
      title: "Agent tree",
      icon: PLUGIN_ICON,
      locations: ["workspace", "explorer"],
      Component: AgentTreePanel,
    }),
    client.addScreen({
      id: RUNS_SCREEN_ID,
      title: "Agent runs",
      Component: createRunsScreen(overview, (id, options) => client.openPanel(id, options)),
    }),
    client.addSidebarHeaderItem({ id: RUNS_SCREEN_ID, title: "Agent runs", Component: createRunsSidebarItem(overview) }),
    client.addCommandCenterItem({
      id: "open-agent-tree",
      title: "Open agent tree",
      icon: PLUGIN_ICON,
      keywords: ["subagents", "workflow", "tokens", "tasks"],
      context: "agent",
      onSelect({ openPanel }) {
        openPanel(PANEL_ID, { location: "explorer" });
      },
    }),
    client.addCommandCenterItem({
      id: "open-agent-runs",
      title: "Open agent runs",
      icon: PLUGIN_ICON,
      keywords: ["subagents", "workflows", "sessions"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: RUNS_SCREEN_ID });
      },
    }),
    // Not "agents": a plugin command would hide Claude Code's own /agents.
    client.addSlashCommand({
      name: "agent-tree",
      description: "Open the agent tree: subagents, workflows, tasks and tokens",
      argumentHint: "",
      context: "agent",
      onSubmit({ openPanel }) {
        openPanel(PANEL_ID, { location: "explorer" });
      },
    }),
    contributeAgentPills(client, overview),
  ];
  return async () => {
    await Promise.all(removers.map((remove) => remove()));
  };
}
