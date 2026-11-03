import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { agentStepsRpc, runsOverviewRpc, sessionTreeRpc, type AgentSteps, type SessionTree } from "../shared/contract";
import { useForeground } from "./foreground";
import type { RunsOverview } from "./overview";

// Every daemon read of the plugin. Polling stops while the app is in the background and while the panel or screen is
// mounted but hidden (`shown`); the cadence follows the data (fast while something runs). networkMode "always": the RPC goes to the Paseo daemon, not the internet, so a
// lost network must not pause a query forever.

const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 15_000;
const RUNS_POLL_MS = 10_000;

/** Anything in the tree still moving: an agent, a workflow or a background task. */
function treeIsLive(tree: SessionTree | undefined): boolean {
  if (!tree || !tree.found) return false;
  return (
    tree.counts.running > 0 ||
    tree.workflows.some((workflow) => workflow.status === "running") ||
    tree.tasks.some((task) => task.status === "running") ||
    tree.main?.currentStep?.status === "running"
  );
}

/**
 * The tree of one Paseo agent. Polled every 2 s while anything runs (in the tree, or the Paseo agent itself),
 * else every 15 s; `visible` false (detail view open) keeps it at 15 s since only the header reads it then.
 */
export function useSessionTree(hostId: string, agentId: string, agentRunning: boolean, visible: boolean, shown: boolean) {
  const getTree = useRpc(sessionTreeRpc);
  const polling = useForeground() && shown;
  return useQuery({
    queryKey: ["agent-tree", hostId, "tree", agentId],
    queryFn: () => getTree({ agentId }),
    enabled: polling,
    refetchInterval: (query) => {
      if (!polling) return false;
      const tree = query.state.data;
      // A running Paseo agent whose session cannot be read (another provider, missing transcript) stays slow.
      const live = treeIsLive(tree) || (agentRunning && tree?.found !== false);
      return live && visible ? FAST_POLL_MS : SLOW_POLL_MS;
    },
    staleTime: 1_000,
    retry: 1,
    networkMode: "always",
  });
}

export interface StepsTarget {
  agentId: string;
  childId: string;
  runId: string | null;
}

/** The detail view's step list. */
export const DETAIL_STEP_LIMIT = 300;
/** The recent steps a row shows when it is expanded. */
export const INLINE_STEP_LIMIT = 20;

function stepsAreLive(steps: AgentSteps | undefined, fallbackRunning: boolean): boolean {
  if (!steps) return fallbackRunning;
  if (steps.node) return steps.node.status === "running";
  return steps.steps.some((step) => step.status === "running") || fallbackRunning;
}

/**
 * The last `limit` steps of one agent of the tree, every 2 s while it runs, else every 15 s. Polling lasts while a
 * shown component shows them (the detail view, an expanded row).
 */
export function useAgentSteps(hostId: string, target: StepsTarget, fallbackRunning: boolean, limit: number, shown: boolean) {
  const getSteps = useRpc(agentStepsRpc);
  const polling = useForeground() && shown;
  return useQuery({
    queryKey: ["agent-tree", hostId, "steps", target.agentId, target.childId, target.runId, limit],
    queryFn: () => getSteps({ ...target, limit }),
    enabled: polling,
    refetchInterval: (query) => {
      if (!polling) return false;
      return stepsAreLive(query.state.data, fallbackRunning) ? FAST_POLL_MS : SLOW_POLL_MS;
    },
    staleTime: 1_000,
    retry: 1,
    networkMode: "always",
  });
}

export const RUNS_SINCE_HOURS = 24;

/**
 * Claude Code sessions of the last 24 h, every 10 s while the runs screen is shown and the app is in front. Each
 * read is also published to the installation's overview store, so pills and the sidebar badge follow it.
 */
export function useRunsOverview(hostId: string, publish: (overview: RunsOverview) => void, shown: boolean) {
  const getOverview = useRpc(runsOverviewRpc);
  const foreground = useForeground() && shown;
  return useQuery({
    queryKey: ["agent-tree", hostId, "runs"],
    queryFn: async () => {
      const overview = await getOverview({ sinceHours: RUNS_SINCE_HOURS });
      publish(overview);
      return overview;
    },
    enabled: foreground,
    refetchInterval: foreground ? RUNS_POLL_MS : false,
    staleTime: 5_000,
    retry: 1,
    networkMode: "always",
  });
}
