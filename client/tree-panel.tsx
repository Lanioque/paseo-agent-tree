import { useAgent, useTabState, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View, type ScrollView as NativeScrollView } from "react-native";
import { AgentDetail } from "./agent-detail";
import { useDelay } from "./clock";
import { errorLook, notFoundLook, paseoStatusLook, runLooks } from "./looks";
import { Notice } from "./primitives";
import { useSessionTree } from "./queries";
import { panelStateSchema, type OpenAgent, type PanelState } from "./selection";
import { maxContentWidth, panePadX, space } from "./theme";
import { TreeBody, type MainAgentInfo, type Toggles } from "./tree-view";
import { useShown, ViewProvider, type ViewState } from "./view";

const closedState: PanelState = { open: null };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The "Agent tree" agent panel, made for the Explorer sidebar: the compact tree of the agent's Claude Code session,
 * and in place of it the step list of one agent once its transcript is opened. The open agent is tab state, so a
 * restored tab reopens it. In a wide workspace tab the same rows get wider, up to a readable width. It paints no
 * background of its own, so it sits on the Explorer's surface like the built-in tabs.
 */
export function AgentTreePanel({ theme, layout, host, params, tab, revision }: PluginAgentPanelProps) {
  const agentId = params.agentId;
  const agent = useAgent(agentId, ({ status, title, createdAt, lastActivityAt }) => ({ status, title, createdAt, lastActivityAt }));
  const [state, setState] = useTabState(tab, panelStateSchema, closedState);
  const [toggles, setToggles] = useState<Toggles>({});
  const treeScrollRef = useRef<NativeScrollView>(null);
  const treeOffset = useRef(0);
  const restoreOffset = useRef<number | null>(null);
  const slowFirstRead = useDelay(300);
  const { shown, onLayout } = useShown();

  // Opening the panel again (Command Center, /agent-tree, the pill) re-sends params: go back to the tree.
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    setState(closedState);
  }, [revision, setState]);

  const agentRunning = agent?.status === "running";
  const query = useSessionTree(host.id, agentId, agentRunning, state.open === null, shown);
  const tree = query.data;

  const view = useMemo<ViewState>(() => ({ colors: theme.colors, compact: layout.compact, shown }), [theme.colors, layout.compact, shown]);
  const main: MainAgentInfo = {
    title: agent?.title ?? "Main session",
    look: agent ? paseoStatusLook(agent.status) : runLooks.unknown,
    live: agentRunning,
    startedAt: agent?.createdAt ?? null,
    endedAt: agent?.lastActivityAt ?? null,
  };

  const onToggle = useCallback((key: string, open: boolean) => setToggles((current) => ({ ...current, [key]: open })), []);
  const openAgent = useCallback(
    (open: OpenAgent) => {
      restoreOffset.current = treeOffset.current;
      setState({ open });
    },
    [setState],
  );
  const back = () => setState(closedState);
  const retry = () => void query.refetch();

  let content: ReactNode;
  if (state.open !== null) {
    content = (
      <AgentDetail
        hostId={host.id}
        agentId={agentId}
        open={state.open}
        tree={tree}
        main={main}
        agentRunning={agentRunning}
        onBack={back}
      />
    );
  } else if (!tree && query.isError) {
    content = (
      <View style={{ padding: panePadX }}>
        <Notice look={errorLook} sentence={`Could not read the agent tree: ${errorMessage(query.error)}`} onRetry={retry} />
      </View>
    );
  } else if (!tree) {
    content = slowFirstRead ? <Loading /> : null;
  } else {
    content = (
      <ScrollView
        ref={treeScrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: panePadX, paddingTop: space.sm, paddingBottom: space.xl * 2 }}
        scrollEventThrottle={100}
        onScroll={(event) => {
          treeOffset.current = event.nativeEvent.contentOffset.y;
        }}
        onContentSizeChange={() => {
          // Back from an agent's steps: return to where the tree was, once it has laid out again.
          if (restoreOffset.current === null) return;
          treeScrollRef.current?.scrollTo({ y: restoreOffset.current, animated: false });
          restoreOffset.current = null;
        }}
      >
        <View style={{ width: "100%", maxWidth: maxContentWidth, alignSelf: "center" }}>
          {query.isError ? <Notice look={errorLook} sentence={`Could not refresh: ${errorMessage(query.error)}`} onRetry={retry} /> : null}
          {tree.found ? (
            <TreeBody tree={tree} main={main} hostId={host.id} agentId={agentId} toggles={toggles} onToggle={onToggle} onOpen={openAgent} />
          ) : (
            <Notice look={notFoundLook} sentence={tree.reason ?? "No Claude Code session was found for this agent."} onRetry={retry} />
          )}
        </View>
      </ScrollView>
    );
  }

  return (
    <ViewProvider value={view}>
      <View style={{ flex: 1 }} onLayout={onLayout}>
        {content}
      </View>
    </ViewProvider>
  );
}
