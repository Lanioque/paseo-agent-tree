import type { PluginClientOpenPanelOptions, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView, SidebarRow, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { SessionSummary } from "../shared/contract";
import { useDelay, useNow } from "./clock";
import { basename, formatAgo, plural, sumTokens, tokenCount } from "./format";
import { PANEL_ID, PLUGIN_ICON, RUNS_SCREEN_ID } from "./ids";
import { errorLook, paseoStatusLook, runLooks } from "./looks";
import { runningAgents, useRunningTotal, type OverviewStore } from "./overview";
import { Glyph, Heading, LineRow, Notice, SecondLine } from "./primitives";
import { RUNS_SINCE_HOURS, useRunsOverview } from "./queries";
import { maxContentWidth, panePadX, space, tabular, text } from "./theme";
import { useShown, useView, ViewProvider, type ViewState } from "./view";

type OpenPanel = (id: string, options: PluginClientOpenPanelOptions) => void;

const isActive = (session: SessionSummary) =>
  session.counts.running > 0 || session.workflowsRunning > 0 || session.tasksRunning > 0;

/** "3 agents running · 1 workflow · 2 tasks", or the agent total once nothing runs. */
function activityLine(session: SessionSummary): string {
  const parts: string[] = [];
  if (session.counts.running > 0) parts.push(`${plural(session.counts.running, "agent", "agents")} running`);
  if (session.workflowsRunning > 0) parts.push(plural(session.workflowsRunning, "workflow", "workflows"));
  if (session.tasksRunning > 0) parts.push(plural(session.tasksRunning, "task", "tasks"));
  if (parts.length === 0 && session.counts.total > 0) parts.push(plural(session.counts.total, "agent", "agents"));
  return parts.join(" · ");
}

/** One session: status, title, how long ago; under it the folder, what runs and its tokens. */
function SessionRow({ session, now, onOpen }: { session: SessionSummary; now: number; onOpen(): void }) {
  const { colors } = useView();
  const look = isActive(session) ? runLooks.running : paseoStatusLook(session.paseoStatus);
  const folder = basename(session.cwd);
  const title = session.title ?? folder;
  const ago = formatAgo(session.lastActivityAt, now);
  const meta = [session.title ? folder : "", activityLine(session), tokenCount(sumTokens(session.totalTokens))].filter(Boolean);
  return (
    <LineRow
      leading={<Glyph look={look} />}
      title={title}
      trailing={ago !== "" ? <Text style={[text("footnote", colors.foregroundMuted), tabular]}>{ago}</Text> : null}
      second={<SecondLine parts={[{ text: meta.join(" · "), tone: "muted" }]} />}
      onPress={onOpen}
      label={[title, look.word, ...meta, ago].filter(Boolean).join(", ")}
      hint="Opens the agent tree in the Explorer"
    />
  );
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The "Agent runs" screen: every Claude Code Paseo agent active in the last 24 h. A row opens that agent's tree
 * panel in its workspace's Explorer; when the app does not hold the agent (archived, other host), it opens the agent
 * instead.
 */
export function createRunsScreen(store: OverviewStore, openPanel: OpenPanel) {
  return function RunsScreen({ theme, host, layout, navigation }: PluginScreenProps) {
    const { shown, onLayout } = useShown();
    const query = useRunsOverview(host.id, store.publish, shown);
    const now = useNow(10_000, shown);
    const toast = useToast();
    const slowFirstRead = useDelay(300);
    const view = useMemo<ViewState>(() => ({ colors: theme.colors, compact: layout.compact, shown }), [theme.colors, layout.compact, shown]);
    const sessions = query.data?.sessions ?? [];

    const open = (session: SessionSummary) => {
      if (session.workspaceId) {
        try {
          openPanel(PANEL_ID, { workspaceId: session.workspaceId, agentId: session.agentId, location: "explorer" });
          return;
        } catch (error) {
          console.error("[agent-tree] could not open the panel, opening the agent instead", error);
        }
      }
      if (navigation) navigation.openAgent({ agentId: session.agentId });
      else toast.error("This agent is not loaded in this app.");
    };

    let body: ReactNode = null;
    if (query.data) {
      const running = runningAgents(sessions);
      body = (
        <View style={{ gap: space.xs }}>
          <Heading
            title="Sessions"
            count={`${sessions.length}`}
            right={
              <Text style={[text("footnote", theme.colors.foregroundMuted), tabular]}>
                {[running > 0 ? `${plural(running, "agent", "agents")} running` : "", `updated ${formatAgo(query.data.generatedAt, now)}`]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            }
          />
          {query.isError ? (
            <Notice look={errorLook} sentence={`Could not refresh: ${errorMessage(query.error)}`} onRetry={() => void query.refetch()} />
          ) : null}
          {sessions.length === 0 ? (
            <Notice sentence={`No Claude Code agent was active in the last ${RUNS_SINCE_HOURS} hours.`} />
          ) : (
            <View>
              {sessions.map((session) => (
                <SessionRow key={session.agentId} session={session} now={now} onOpen={() => open(session)} />
              ))}
            </View>
          )}
        </View>
      );
    } else if (query.isError) {
      body = <Notice look={errorLook} sentence={`Could not read the runs: ${errorMessage(query.error)}`} onRetry={() => void query.refetch()} />;
    } else if (slowFirstRead) {
      body = <Loading />;
    }

    return (
      <ViewProvider value={view}>
        <ScrollView
          onLayout={onLayout}
          style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
          contentContainerStyle={{ paddingHorizontal: layout.compact ? panePadX : space.xl, paddingVertical: space.lg, flexGrow: 1 }}
        >
          <View style={{ width: "100%", maxWidth: maxContentWidth, alignSelf: "center", flexGrow: 1 }}>{body}</View>
        </ScrollView>
      </ViewProvider>
    );
  };
}

/** "Agent runs" in the sidebar header, with the number of running agents as a plain trailing count. */
export function createRunsSidebarItem(store: OverviewStore) {
  return function RunsSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
    const running = useRunningTotal(store);
    const trailing =
      running > 0 ? (
        <View
          accessible
          accessibilityLabel={`${plural(running, "agent", "agents")} running`}
          style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}
        >
          <Icon name={runLooks.running.icon} size={12} color={theme.colors.accent} />
          <Text style={[text("footnote", theme.colors.foreground, "500"), tabular]}>{running}</Text>
        </View>
      ) : null;
    return (
      <SidebarRow
        icon={PLUGIN_ICON}
        active={currentScreen?.screenId === RUNS_SCREEN_ID}
        onPress={() => openScreen({ screenId: RUNS_SCREEN_ID })}
        trailing={trailing}
      />
    );
  };
}
