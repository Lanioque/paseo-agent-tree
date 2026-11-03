import { Icon, Markdown, ScrollView } from "@getpaseo/plugin/client/ui";
import { memo, useCallback, useRef, useState, type ReactNode } from "react";
import { Text, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView as NativeScrollView } from "react-native";
import type { AgentNode, AgentSteps, SessionTree, Step, Tokens } from "../shared/contract";
import { useDelay, useSecondTick } from "./clock";
import { elapsedMs, formatDuration, shortModel, stepName, stepTitle, sumTokens, tokenBreakdown, transcriptFooter } from "./format";
import { errorLook, notFoundLook, runLooks, stepIcon, stepStatusLooks, toneColor, type Look } from "./looks";
import { Chevron, Elapsed, Glyph, Heading, MonoBlock, Notice, TextLink, Touchable } from "./primitives";
import { DETAIL_STEP_LIMIT, useAgentSteps } from "./queries";
import { sameFlat, stepDuration } from "./rows";
import { MAIN_CHILD_ID, type OpenAgent } from "./selection";
import { footnoteLine, hairline, maxContentWidth, panePadX, row, space, tabular, text, titleIndent } from "./theme";
import type { MainAgentInfo } from "./tree-view";
import { useView } from "./view";

/** Within this many pixels of the end counts as "at the bottom": new steps then keep the view pinned to the end. */
const BOTTOM_SLACK = 32;

/** What the header shows, from the steps response once loaded, else from the tree row that was pressed. */
interface HeaderModel {
  label: string;
  look: Look;
  meta: string[];
  startedAt: string | null;
  /** The end, or the last activity of a run that stopped without one. */
  endedAt: string | null;
  live: boolean;
  toolCalls: number | null;
  tokens: Tokens | null;
  context: number | null;
  sessionId: string | null;
}

function nodeHeader(node: AgentNode): HeaderModel {
  return {
    label: node.label,
    look: runLooks[node.status],
    meta: [
      node.model ? shortModel(node.model) : "",
      node.phase ?? "",
      node.agentType ?? "",
      node.effort ? `effort ${node.effort}` : "",
      node.background ? "background" : "",
    ].filter(Boolean),
    startedAt: node.startedAt,
    endedAt: node.status === "running" ? null : node.endedAt ?? node.lastActivityAt,
    live: node.status === "running",
    toolCalls: node.toolCalls,
    tokens: node.tokens,
    context: node.contextTokens,
    sessionId: null,
  };
}

function mainHeader(tree: SessionTree | undefined, main: MainAgentInfo): HeaderModel {
  const session = tree?.main ?? null;
  return {
    label: main.title,
    look: main.look,
    meta: ["Main session", tree?.model ? shortModel(tree.model) : ""].filter(Boolean),
    startedAt: main.startedAt,
    endedAt: main.live ? null : main.endedAt,
    live: main.live,
    toolCalls: session?.toolCalls ?? null,
    tokens: session?.tokens ?? null,
    context: session?.contextTokens ?? null,
    sessionId: tree?.sessionId ?? null,
  };
}

/** A child the tree no longer lists and whose steps have not arrived: its label, nothing else. */
function placeholderHeader(label: string): HeaderModel {
  return {
    label,
    look: runLooks.unknown,
    meta: [],
    startedAt: null,
    endedAt: null,
    live: false,
    toolCalls: null,
    tokens: null,
    context: null,
    sessionId: null,
  };
}

/** The node of the tree a selection points at, used until its steps arrive. */
function findNode(tree: SessionTree | undefined, open: OpenAgent): AgentNode | null {
  if (!tree || open.childId === MAIN_CHILD_ID) return null;
  if (open.runId !== null) {
    const workflow = tree.workflows.find((candidate) => candidate.runId === open.runId);
    const agents = workflow?.phases.flatMap((phase) => phase.agents) ?? [];
    return agents.find((agent) => agent.id === open.childId) ?? null;
  }
  return tree.subagents.find((agent) => agent.id === open.childId) ?? null;
}

/** "12 tool calls · 45.2k tokens · 1m 23s", the time ticking while it runs. */
function CounterLine({ model }: { model: HeaderModel }) {
  const { colors, shown } = useView();
  const now = useSecondTick(model.live && shown);
  if (model.toolCalls === null || model.tokens === null) return null;
  const ms = model.live || model.endedAt !== null ? elapsedMs(model.startedAt, model.live ? null : model.endedAt, now) : null;
  return (
    <Text style={[text("footnote", colors.foregroundMuted), tabular]}>
      {transcriptFooter(model.toolCalls, sumTokens(model.tokens), ms === null ? "" : formatDuration(ms))}
    </Text>
  );
}

function DetailHeader({ model }: { model: HeaderModel }) {
  const { colors } = useView();
  const breakdown = model.tokens ? tokenBreakdown(model.tokens, model.context) : "";
  return (
    <View style={{ paddingHorizontal: row.padX, gap: space.xxs }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: row.gap }}>
        <View style={{ width: row.glyph, height: 20, alignItems: "center", justifyContent: "center" }}>
          <Glyph look={model.look} />
        </View>
        <Text selectable numberOfLines={2} style={[text("title", colors.foreground, "500"), { flex: 1 }]}>
          {model.label}
        </Text>
      </View>
      <View style={{ paddingLeft: titleIndent - row.padX, gap: space.xxs }}>
        <Text numberOfLines={2} style={text("footnote", colors.foregroundMuted)}>
          {[model.look.word, ...model.meta].join(" · ")}
        </Text>
        <CounterLine model={model} />
        {breakdown !== "" ? <Text style={[text("footnote", colors.foregroundMuted), tabular]}>{breakdown}</Text> : null}
        {model.sessionId ? (
          <Text selectable numberOfLines={1} style={[text("footnote", colors.foregroundMuted), tabular]}>
            {`Claude session ${model.sessionId}`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Long enough to fold: more than four lines or about four lines of wrapped text. */
const isLong = (value: string) => value.split("\n").length > 4 || value.length > 320;

function PromptSection({ prompt }: { prompt: string }) {
  const { colors } = useView();
  const [open, setOpen] = useState(false);
  const long = isLong(prompt);
  return (
    <View style={{ gap: space.xs }}>
      <Heading title="Prompt" right={long ? <TextLink label={open ? "Show less" : "Show all"} onPress={() => setOpen(!open)} /> : undefined} />
      <Text selectable numberOfLines={open || !long ? undefined : 4} style={[text("body", colors.foreground), { paddingHorizontal: row.padX }]}>
        {prompt}
      </Text>
    </View>
  );
}

interface StepRowProps {
  step: Step;
  open: boolean;
  onToggle(id: string): void;
}

/** One step on a 26 px line: tool glyph, name, subject, time; pressing it shows its input and result. */
const StepRow = memo(
  function StepRow({ step, open, onToggle }: StepRowProps) {
    const { colors, compact } = useView();
    const status = stepStatusLooks[step.status];
    const name = stepName(step);
    const title = stepTitle(step);
    const expandable = step.detail !== null || step.resultPreview !== null || title.length > 60;
    const iconColor = step.status === "ok" ? colors.foregroundMuted : toneColor(status.tone, colors);
    const duration = stepDuration(step);
    const line = (
      <View style={{ flexDirection: "row", alignItems: "flex-start", paddingHorizontal: row.padX, paddingVertical: compact ? (row.touch - row.line) / 2 : 0 }}>
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={status.word}
          style={{ width: row.glyph, height: row.line, alignItems: "center", justifyContent: "center" }}
        >
          <Icon name={step.status === "running" ? status.icon : stepIcon(step)} size={12} color={iconColor} />
        </View>
        <View style={{ flex: 1, minWidth: 0, marginLeft: row.gap, flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: (row.line - footnoteLine) / 2 }}>
          <Text numberOfLines={1} style={[text("footnote", colors.foreground, "500"), { flexShrink: 0, maxWidth: "45%" }]}>
            {name}
          </Text>
          <Text numberOfLines={open ? undefined : 1} style={[text("footnote", colors.foregroundMuted), { flex: 1, minWidth: 0 }]}>
            {title}
          </Text>
          {step.status === "running" ? (
            <Elapsed startedAt={step.at} endedAt={null} live />
          ) : step.status === "error" ? (
            <Text style={text("footnote", colors.statusDanger)}>Error</Text>
          ) : duration !== "" ? (
            <Text style={[text("footnote", colors.foregroundMuted), tabular]}>{duration}</Text>
          ) : null}
        </View>
        <View style={{ width: row.endSlot, height: row.line, alignItems: "center", justifyContent: "center" }}>
          {expandable ? <Chevron open={open} size={14} /> : null}
        </View>
      </View>
    );
    const label = [name, title, status.word, duration].filter(Boolean).join(", ");
    return (
      <View>
        {expandable ? (
          <Touchable
            onPress={() => onToggle(step.id)}
            label={label}
            hint={open ? "Hides the input and result" : "Shows the input and result"}
            expanded={open}
            style={{ borderRadius: row.radius }}
          >
            {line}
          </Touchable>
        ) : (
          <View accessible accessibilityLabel={label}>
            {line}
          </View>
        )}
        {open ? (
          <View style={{ marginLeft: titleIndent, marginRight: row.endSlot + row.padX, gap: space.xs, paddingBottom: space.md }}>
            {step.detail !== null ? <MonoBlock value={step.detail} /> : null}
            {step.resultPreview !== null ? (
              <View style={{ gap: space.xxs }}>
                <Text style={text("footnote", step.status === "error" ? colors.statusDanger : colors.foregroundMuted)}>
                  {step.status === "error" ? "Error" : "Result"}
                </Text>
                <MonoBlock value={step.resultPreview} />
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  },
  (before, after) => before.open === after.open && before.onToggle === after.onToggle && sameFlat(before.step, after.step),
);

function StepsSection({ steps, onNewest }: { steps: AgentSteps; onNewest(): void }) {
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (id: string) =>
      setOpenIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  return (
    <View style={{ gap: space.xs }}>
      <Heading
        title="Steps"
        count={`${steps.steps.length}`}
        right={steps.steps.length > 8 ? <TextLink label="Newest" accessibilityLabel="Scroll to the newest step" onPress={onNewest} /> : undefined}
      />
      {steps.truncated ? <Notice sentence={`Older steps are hidden: showing the last ${steps.steps.length}.`} /> : null}
      {steps.steps.length === 0 ? <Notice sentence="No steps yet." /> : null}
      <View>
        {steps.steps.map((step) => (
          <StepRow key={step.id} step={step} open={openIds.has(step.id)} onToggle={toggle} />
        ))}
      </View>
    </View>
  );
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface AgentDetailProps {
  hostId: string;
  agentId: string;
  open: OpenAgent;
  tree: SessionTree | undefined;
  main: MainAgentInfo;
  /** The Paseo agent itself runs: the main session's steps poll fast. */
  agentRunning: boolean;
  onBack(): void;
}

/** One agent's header, prompt, step list and final answer, under a back row to the tree. */
export function AgentDetail({ hostId, agentId, open, tree, main, agentRunning, onBack }: AgentDetailProps) {
  const { colors, compact, shown } = useView();
  const isMain = open.childId === MAIN_CHILD_ID;
  const fallbackNode = findNode(tree, open);
  const fallbackRunning = isMain ? agentRunning : fallbackNode?.status === "running";
  const query = useAgentSteps(hostId, { agentId, childId: open.childId, runId: open.runId }, fallbackRunning, DETAIL_STEP_LIMIT, shown);
  const slowFirstRead = useDelay(300);
  const steps = query.data;

  const scrollRef = useRef<NativeScrollView>(null);
  const atBottom = useRef(false);
  const viewport = useRef(0);
  const contentHeight = useRef<number | null>(null);

  const node = steps?.node ?? fallbackNode;
  const header = node ? nodeHeader(node) : isMain ? mainHeader(tree, main) : placeholderHeader(open.label);
  const finished = !(node ? node.status === "running" : agentRunning);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - BOTTOM_SLACK;
  };
  // The first layout with steps is the baseline (the view opens at the top); after that, growth follows the end
  // only when the reader was already there, or when everything fitted on screen before.
  const onContentSizeChange = (_width: number, height: number) => {
    if (!steps) return;
    const previous = contentHeight.current;
    contentHeight.current = height;
    if (previous === null || height <= previous) return;
    if (atBottom.current || previous <= viewport.current + BOTTOM_SLACK) {
      scrollRef.current?.scrollToEnd({ animated: false });
      atBottom.current = true;
    }
  };
  const scrollToNewest = () => {
    atBottom.current = true;
    scrollRef.current?.scrollToEnd({ animated: true });
  };

  let body: ReactNode = null;
  if (steps && !steps.found) {
    body = <Notice look={notFoundLook} sentence="This agent's transcript was not found. It may have been moved or deleted." onRetry={() => void query.refetch()} />;
  } else if (steps) {
    body = (
      <>
        {query.isError ? <Notice look={errorLook} sentence={`Could not refresh: ${errorMessage(query.error)}`} onRetry={() => void query.refetch()} /> : null}
        {steps.prompt ? <PromptSection prompt={steps.prompt} /> : null}
        <StepsSection steps={steps} onNewest={scrollToNewest} />
        {finished && steps.finalText ? (
          <View style={{ gap: space.xs }}>
            <Heading title="Final answer" />
            <View style={{ paddingHorizontal: row.padX }}>
              <Markdown>{steps.finalText}</Markdown>
            </View>
          </View>
        ) : null}
      </>
    );
  } else if (query.isError) {
    body = <Notice look={errorLook} sentence={`Could not read the steps: ${errorMessage(query.error)}`} onRetry={() => void query.refetch()} />;
  } else if (slowFirstRead) {
    body = <Notice sentence="Reading the transcript…" />;
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: panePadX, paddingVertical: space.xxs, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
        <Touchable
          onPress={onBack}
          label="Back to the agent tree"
          style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: compact ? row.touch : row.line, paddingHorizontal: row.padX, borderRadius: row.radius }}
        >
          <Icon name="ChevronLeft" size={14} color={colors.foregroundMuted} />
          <Text style={text("footnote", colors.foregroundMuted, "500")}>Agent tree</Text>
          <Text numberOfLines={1} style={[text("footnote", colors.foregroundMuted), { flex: 1 }]}>
            {`/ ${open.label}`}
          </Text>
        </Touchable>
      </View>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: panePadX, paddingTop: space.lg, paddingBottom: space.xl * 2 }}
        onScroll={onScroll}
        scrollEventThrottle={100}
        onLayout={(event) => {
          viewport.current = event.nativeEvent.layout.height;
        }}
        onContentSizeChange={onContentSizeChange}
      >
        <View style={{ width: "100%", maxWidth: maxContentWidth, alignSelf: "center", gap: space.xl }}>
          <DetailHeader model={header} />
          {body}
        </View>
      </ScrollView>
    </View>
  );
}
