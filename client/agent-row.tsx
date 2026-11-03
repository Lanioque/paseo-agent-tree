import { ScrollView } from "@getpaseo/plugin/client/ui";
import { memo, useRef, type ReactNode } from "react";
import { Text, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView as NativeScrollView } from "react-native";
import type { AgentNode, Step } from "../shared/contract";
import { useDelay } from "./clock";
import { stepName, stepSubject, stepTitle } from "./format";
import { AGENT_ICON, runLooks, stepStatusLooks } from "./looks";
import { Elapsed, LineRow, SecondLine, TextLink, TrailingText, TypeIcon } from "./primitives";
import { INLINE_STEP_LIMIT, useAgentSteps } from "./queries";
import { agentSecondLine, agentSpan, sameFlat, sameNode, stepDuration, trailingFor } from "./rows";
import type { OpenAgent } from "./selection";
import { footnoteLine, mono, row, space, tabular, text, titleIndent } from "./theme";
import { useView } from "./view";

/** The inline step list stays pinned to its end within this many pixels, unless the reader scrolled up. */
const BOTTOM_SLACK = 16;
/** Height of the inline step list before it scrolls: about eleven tool calls. */
const INLINE_MAX_HEIGHT = 200;
const CONNECTOR_WIDTH = 16;
/** One tool call per 20 px line. */
const LINE = 20;

/** A tool call: its name, its subject (a file tool's file name), and how long it took (live while it runs, "Error"). */
const InlineStep = memo(
  function InlineStep({ step }: { step: Step }) {
    const { colors } = useView();
    const name = stepName(step);
    const duration = stepDuration(step);
    const status = stepStatusLooks[step.status];
    return (
      <View
        accessible
        accessibilityLabel={[name, stepTitle(step), status.word, duration].filter(Boolean).join(", ")}
        style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: LINE }}
      >
        <Text numberOfLines={1} style={[text("footnote", colors.foreground, "500"), { flexShrink: 0, maxWidth: "45%" }]}>
          {name}
        </Text>
        <Text numberOfLines={1} style={[text("footnote", colors.foregroundMuted), { flex: 1, minWidth: 0 }]}>
          {stepSubject(step)}
        </Text>
        {step.status === "running" ? (
          <Elapsed startedAt={step.at} endedAt={null} live />
        ) : step.status === "error" ? (
          <Text style={text("footnote", colors.statusDanger)}>Error</Text>
        ) : duration !== "" ? (
          <Text style={[text("footnote", colors.foregroundMuted), tabular]}>{duration}</Text>
        ) : null}
      </View>
    );
  },
  (before, after) => sameFlat(before.step, after.step),
);

function Muted({ children }: { children: string }) {
  const { colors } = useView();
  return <Text style={[text("footnote", colors.foregroundMuted), { paddingVertical: (LINE - footnoteLine) / 2 }]}>{children}</Text>;
}

interface InlineStepsProps {
  hostId: string;
  agentId: string;
  node: AgentNode;
  runId: string | null;
  onOpen(open: OpenAgent): void;
}

/**
 * Under an expanded row, after a "⎿" connector: its last tool calls, read on expand and polled while it stays open
 * (every 2 s while the agent runs), in a 200 px list that follows the newest call; then its result once finished,
 * and the way into the full transcript.
 */
function InlineSteps({ hostId, agentId, node, runId, onOpen }: InlineStepsProps) {
  const { colors, shown } = useView();
  const running = node.status === "running";
  const query = useAgentSteps(hostId, { agentId, childId: node.id, runId }, running, INLINE_STEP_LIMIT, shown);
  const slowFirstRead = useDelay(300);
  const scrollRef = useRef<NativeScrollView>(null);
  const atBottom = useRef(true);
  const steps = query.data;
  const tools = steps?.steps.filter((step) => step.kind === "tool") ?? [];

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - BOTTOM_SLACK;
  };
  const followEnd = () => {
    if (atBottom.current) scrollRef.current?.scrollToEnd({ animated: false });
  };

  let list: ReactNode = null;
  if (steps && !steps.found) list = <Muted>Transcript not found</Muted>;
  else if (steps && tools.length === 0) list = <Muted>{running ? "No tool calls yet" : "No tool calls"}</Muted>;
  else if (steps) {
    list = (
      <ScrollView
        ref={scrollRef}
        nestedScrollEnabled
        style={{ maxHeight: INLINE_MAX_HEIGHT }}
        scrollEventThrottle={100}
        onScroll={onScroll}
        onLayout={followEnd}
        onContentSizeChange={followEnd}
      >
        {steps.truncated ? <Muted>Earlier steps not shown</Muted> : null}
        {tools.map((step) => (
          <InlineStep key={step.id} step={step} />
        ))}
      </ScrollView>
    );
  } else if (query.isError) {
    list = (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <Muted>Could not read the steps</Muted>
        <TextLink label="Retry" onPress={() => void query.refetch()} />
      </View>
    );
  } else if (slowFirstRead) {
    list = <Muted>Loading steps…</Muted>;
  }

  return (
    <View style={{ marginLeft: titleIndent, marginRight: row.endSlot + row.padX, paddingTop: space.xxs, paddingBottom: space.md, gap: space.sm }}>
      {list === null ? null : (
        <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
          <Text accessible={false} style={[mono(colors.foregroundMuted), { width: CONNECTOR_WIDTH, lineHeight: LINE }]}>
            ⎿
          </Text>
          <View style={{ flex: 1, minWidth: 0 }}>{list}</View>
        </View>
      )}
      {!running && node.resultPreview ? (
        <Text selectable numberOfLines={6} style={text("footnote", colors.foreground)}>
          {node.resultPreview}
        </Text>
      ) : null}
      <TextLink
        label="View transcript"
        accessibilityLabel={`View transcript for ${node.label}`}
        onPress={() => onOpen({ childId: node.id, runId, label: node.label })}
      />
    </View>
  );
}

interface AgentRowProps {
  hostId: string;
  /** The Paseo agent whose tree this is. */
  agentId: string;
  node: AgentNode;
  /** Set for workflow agents. */
  runId: string | null;
  /** The main session's model: a row names its model only when it differs. */
  sessionModel: string | null;
  /** Key of the row's fold in the panel's toggles. */
  toggleKey: string;
  expanded: boolean;
  onToggle(key: string, open: boolean): void;
  onOpen(open: OpenAgent): void;
}

/**
 * One agent: its icon, label, and live time, duration or status word; under it what it does now, or its model and
 * tokens once it finished. Pressing it expands its last tool calls in place. Every poll brings a fresh node: the row
 * renders only when its own node or its fold changed.
 */
export const AgentRow = memo(
  function AgentRow({ hostId, agentId, node, runId, sessionModel, toggleKey, expanded, onToggle, onOpen }: AgentRowProps) {
    const look = runLooks[node.status];
    const second = agentSecondLine(node, sessionModel);
    const trailing = trailingFor(node.status, agentSpan(node));
    const kind = [node.agentType ?? "", node.background ? "background" : "", node.depth > 1 ? "nested" : ""].filter(Boolean);
    // Screen readers get the full step title (a file tool's whole path), not the row's file name.
    const doing = node.status === "running" && node.currentStep ? [stepName(node.currentStep), stepTitle(node.currentStep)] : second.map((part) => part.text);
    return (
      <View>
        <LineRow
          leading={<TypeIcon name={AGENT_ICON} />}
          title={node.label}
          trailing={trailing ? <TrailingText trailing={trailing} startedAt={node.startedAt} /> : null}
          second={second.length > 0 ? <SecondLine parts={second} /> : null}
          onPress={() => onToggle(toggleKey, !expanded)}
          expanded={expanded}
          label={[node.label, look.word, ...kind, trailing?.kind === "duration" ? trailing.text : "", ...doing].filter(Boolean).join(", ")}
          hint={expanded ? "Hides its recent tool calls" : "Shows its recent tool calls"}
        />
        {expanded ? <InlineSteps hostId={hostId} agentId={agentId} node={node} runId={runId} onOpen={onOpen} /> : null}
      </View>
    );
  },
  (before, after) =>
    before.expanded === after.expanded &&
    before.toggleKey === after.toggleKey &&
    before.onToggle === after.onToggle &&
    before.onOpen === after.onOpen &&
    before.hostId === after.hostId &&
    before.agentId === after.agentId &&
    before.runId === after.runId &&
    before.sessionModel === after.sessionModel &&
    sameNode(before.node, after.node),
);
