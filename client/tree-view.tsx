import { Icon } from "@getpaseo/plugin/client/ui";
import { memo, type ReactNode } from "react";
import { Text, View, type ViewStyle } from "react-native";
import type { AgentNode, BackgroundTask, Phase, SessionTree, Todo, Workflow } from "../shared/contract";
import { AgentRow } from "./agent-row";
import { parseTime, sumTokens } from "./format";
import { AGENT_ICON, kindIcons, runLooks, taskKindWords, type Look } from "./looks";
import { Cells, Chevron, Elapsed, FootnoteToggle, LineRow, RailSection, SecondLine, Touchable, TrailingText, TypeIcon } from "./primitives";
import {
  cellsSummary,
  hasLive,
  itemTiming,
  limitRows,
  phaseHeading,
  phaseProgress,
  runningTotal,
  sameFlat,
  sectionSummary,
  spanMs,
  splitRows,
  summaryParts,
  taskNote,
  trailingFor,
  treeItems,
  visibleTasks,
  workflowCells,
  workflowParts,
  type CellState,
  type Part,
  type Timing,
  type TreeItem,
} from "./rows";
import { MAIN_CHILD_ID, type OpenAgent } from "./selection";
import { hairline, row, space, tabular, text } from "./theme";
import { useView } from "./view";

/** The Paseo agent itself: its status and the span the summary line times. */
export interface MainAgentInfo {
  title: string;
  look: Look;
  live: boolean;
  /** When the Paseo agent was created. */
  startedAt: string | null;
  /** Its last activity, the end of the span while it does not run. */
  endedAt: string | null;
}

/** Fold state chosen by the user, by key; a key without a choice takes the default its row gives. */
export type Toggles = Readonly<Record<string, boolean>>;

interface Wiring {
  hostId: string;
  agentId: string;
  sessionModel: string | null;
  toggles: Toggles;
  onToggle(key: string, open: boolean): void;
  onOpen(open: OpenAgent): void;
}

const isOpen = (toggles: Toggles, key: string, fallback: boolean) => toggles[key] ?? fallback;

/**
 * The main session above the list: "Main", its time on the right (a ticking leaf while it runs, so the row itself
 * does not re-render every second), what runs under it and its tokens below. Opens the main session's steps.
 */
function MainRow({ main, running, tokens, onOpen }: { main: MainAgentInfo; running: number; tokens: number; onOpen(): void }) {
  const { colors } = useView();
  const parts = summaryParts(running, tokens);
  const trailing =
    main.look.tone === "danger" ? (
      <Text style={text("footnote", colors.statusDanger)}>{main.look.word}</Text>
    ) : (
      <Elapsed startedAt={main.startedAt} endedAt={main.endedAt} live={main.live} />
    );
  return (
    <LineRow
      leading={<TypeIcon name={AGENT_ICON} />}
      title="Main"
      trailing={trailing}
      second={<SecondLine parts={parts} />}
      onPress={onOpen}
      label={["Main session", main.look.word, ...parts.map((part) => part.text)].join(", ")}
      hint="Opens the main session's steps"
    />
  );
}

/** Rows of one list: live ones, then a "{n} finished" row folding the rest while something runs, then "Show more". */
function RowList<T>({
  scope,
  items,
  timing,
  fold,
  toggles,
  onToggle,
  render,
}: {
  scope: string;
  items: readonly T[];
  timing(item: T): Timing;
  fold: boolean;
  toggles: Toggles;
  onToggle(key: string, open: boolean): void;
  render(item: T): ReactNode;
}) {
  const { shown, folded } = splitRows(items, timing, fold);
  const finishedKey = `finished:${scope}`;
  const moreKey = `more:${scope}`;
  const finishedOpen = isOpen(toggles, finishedKey, false);
  const showAll = isOpen(toggles, moreKey, false);
  const head = folded.length === 0 ? limitRows(shown, showAll) : { rows: shown, more: false };
  const tail = folded.length > 0 && finishedOpen ? limitRows(folded, showAll) : { rows: [], more: false };
  const more = head.more || tail.more;
  return (
    <View>
      {head.rows.map(render)}
      {folded.length > 0 ? (
        <FootnoteToggle
          label={`${folded.length} finished`}
          onPress={() => onToggle(finishedKey, !finishedOpen)}
          expanded={finishedOpen}
          hint={finishedOpen ? "Hides the finished rows" : "Shows the finished rows"}
        />
      ) : null}
      {tail.rows.map(render)}
      {more ? <FootnoteToggle label={showAll ? "Show less" : "Show more"} onPress={() => onToggle(moreKey, !showAll)} /> : null}
    </View>
  );
}

const nodeTiming = (node: AgentNode) => node;

/** A phase opens by itself while one of its agents runs, waits or failed. */
const attention: ReadonlySet<AgentNode["status"]> = new Set(["running", "pending", "failed"]);

/** A workflow's own row: name, live time, duration or status, "6/10 agents  1.2M tokens", then one cell per agent. */
const WorkflowHeader = memo(
  function WorkflowHeader({
    name,
    status,
    startedAt,
    endedAt,
    parts,
    cells,
    label,
    toggleKey,
    expanded,
    onToggle,
  }: {
    name: string;
    status: Workflow["status"];
    startedAt: string | null;
    endedAt: string | null;
    parts: readonly Part[];
    cells: readonly CellState[];
    label: string;
    toggleKey: string;
    expanded: boolean;
    onToggle(key: string, open: boolean): void;
  }) {
    const trailing = trailingFor(status, spanMs(startedAt, endedAt));
    return (
      <LineRow
        leading={<TypeIcon name={kindIcons.workflow} />}
        title={name}
        trailing={trailing ? <TrailingText trailing={trailing} startedAt={startedAt} /> : null}
        second={
          <View>
            <SecondLine parts={parts} />
            <Cells cells={cells} summary={cellsSummary(cells)} />
          </View>
        }
        onPress={() => onToggle(toggleKey, !expanded)}
        expanded={expanded}
        label={label}
        hint={expanded ? "Collapses the workflow" : "Expands the workflow"}
      />
    );
  },
  (before, after) =>
    before.name === after.name &&
    before.status === after.status &&
    before.startedAt === after.startedAt &&
    before.endedAt === after.endedAt &&
    before.label === after.label &&
    before.toggleKey === after.toggleKey &&
    before.expanded === after.expanded &&
    before.onToggle === after.onToggle &&
    before.cells.join() === after.cells.join() &&
    before.parts.map((part) => part.text).join() === after.parts.map((part) => part.text).join(),
);

const workflowKey = (workflow: Workflow) => `wf:${workflow.runId}`;

/** A phase sub-header: its title and "{done}/{total}"; pressing it folds its agents. */
function PhaseHeader({ phase, title, open, onToggle }: { phase: Phase; title: string; open: boolean; onToggle(): void }) {
  const { colors, compact } = useView();
  const progress = phaseProgress(phase);
  const color = phase.status === "running" ? colors.foreground : phase.status === "failed" ? colors.statusDanger : colors.foregroundMuted;
  const content = (
    <>
      <Text numberOfLines={1} style={[text("footnote", color, "500"), { flex: 1, minWidth: 0 }]}>
        {title}
      </Text>
      <Text style={[text("footnote", colors.foregroundMuted), tabular]}>{progress.short}</Text>
      <View style={{ width: row.endSlot, alignItems: "center" }}>{phase.agents.length > 0 ? <Chevron open={open} size={12} /> : null}</View>
    </>
  );
  const style = { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: compact ? row.touch : 24, paddingHorizontal: row.padX, borderRadius: row.radius } as const;
  if (phase.agents.length === 0) {
    return (
      <View accessible accessibilityRole="header" accessibilityLabel={`${title}, ${progress.sentence}`} style={style}>
        {content}
      </View>
    );
  }
  return (
    <Touchable onPress={onToggle} label={`${title}, ${runLooks[phase.status].word}, ${progress.sentence}`} expanded={open} style={style}>
      {content}
    </Touchable>
  );
}

function agentRow(wiring: Wiring, runId: string | null, node: AgentNode, reactKey: string) {
  const key = `row:${runId ?? "sub"}:${node.id}`;
  return (
    <AgentRow
      key={reactKey}
      hostId={wiring.hostId}
      agentId={wiring.agentId}
      node={node}
      runId={runId}
      sessionModel={wiring.sessionModel}
      toggleKey={key}
      expanded={isOpen(wiring.toggles, key, false)}
      onToggle={wiring.onToggle}
      onOpen={wiring.onOpen}
    />
  );
}

/** A workflow: its row, and when expanded its phases and agents under a 1 px guide line. */
function WorkflowBlock({ workflow, now, wiring }: { workflow: Workflow; now: number; wiring: Wiring }) {
  const { colors } = useView();
  const key = workflowKey(workflow);
  const running = workflow.status === "running";
  const expanded = isOpen(wiring.toggles, key, running);
  const cells = workflowCells(workflow, now);
  const parts = workflowParts(workflow, cells);
  const look = runLooks[workflow.status];
  const renderAgent = (node: AgentNode) => agentRow(wiring, workflow.runId, node, node.id);
  return (
    <View>
      <WorkflowHeader
        name={workflow.name}
        status={workflow.status}
        startedAt={workflow.startedAt}
        endedAt={workflow.endedAt}
        parts={parts}
        cells={cells}
        label={[workflow.name, "Workflow", look.word, workflow.description ?? "", ...parts.map((part) => part.text), cells.length > 0 ? cellsSummary(cells) : ""]
          .filter(Boolean)
          .join(", ")}
        toggleKey={key}
        expanded={expanded}
        onToggle={wiring.onToggle}
      />
      {expanded ? (
        <View style={{ marginLeft: row.padX + row.glyph / 2, paddingLeft: space.xs, borderLeftWidth: hairline, borderLeftColor: colors.border, marginBottom: space.xs }}>
          {workflow.phases.map((phase) => {
            const heading = phaseHeading(phase, workflow.phases.length);
            const phaseKey = `phase:${workflow.runId}:${phase.title}`;
            const phaseOpen = heading === null || isOpen(wiring.toggles, phaseKey, phase.agents.some((agent) => attention.has(agent.status)));
            return (
              <View key={phase.title}>
                {heading !== null ? (
                  <PhaseHeader phase={phase} title={heading} open={phaseOpen} onToggle={() => wiring.onToggle(phaseKey, !phaseOpen)} />
                ) : null}
                {phaseOpen && phase.agents.length > 0 ? (
                  <RowList
                    scope={`${workflow.runId}:${phase.title}`}
                    items={phase.agents}
                    timing={nodeTiming}
                    fold={heading === null && running}
                    toggles={wiring.toggles}
                    onToggle={wiring.onToggle}
                    render={renderAgent}
                  />
                ) : null}
              </View>
            );
          })}
          {workflow.resultPreview && !running ? (
            <Text selectable numberOfLines={6} style={[text("footnote", colors.foreground), { paddingHorizontal: row.padX, paddingTop: space.xs }]}>
              {workflow.resultPreview}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A background shell or task: type icon, title, live time, duration or status; under it "exit 1" or "time limit". */
const TaskRow = memo(
  function TaskRow({ task }: { task: BackgroundTask }) {
    const look = runLooks[task.status];
    const trailing = trailingFor(task.status, spanMs(task.startedAt, task.endedAt));
    const note = taskNote(task);
    return (
      <LineRow
        leading={<TypeIcon name={kindIcons[task.kind]} />}
        title={task.title}
        trailing={trailing ? <TrailingText trailing={trailing} startedAt={task.startedAt} /> : null}
        second={note !== "" ? <SecondLine parts={[{ text: note, tone: "muted" }]} /> : null}
        label={[task.title, taskKindWords[task.kind], look.word, trailing?.kind === "duration" ? trailing.text : "", note].filter(Boolean).join(", ")}
      />
    );
  },
  (before, after) => sameFlat(before.task, after.task),
);

const todoWords: Record<Todo["status"], string> = { pending: "To do", in_progress: "In progress", completed: "Completed" };

/** The box of a todo's mark; the timeline stops at its edges. */
const MARK = 16;

/** A todo on the progress timeline: check when done, accent dot for the current one, small dot for the rest. */
const TodoRow = memo(
  function TodoRow({ todo, first, last }: { todo: Todo; first: boolean; last: boolean }) {
    const { colors, compact } = useView();
    const current = todo.status === "in_progress";
    const label = current ? todo.activeForm ?? todo.content : todo.content;
    const center = (compact ? (row.touch - row.line) / 2 : 0) + row.line / 2;
    const segment = (place: ViewStyle) => (
      <View style={[{ position: "absolute", left: row.padX + row.glyph / 2 - 1, width: 2, backgroundColor: colors.border }, place]} />
    );
    const mark =
      todo.status === "completed" ? (
        <Icon name="CircleCheck" size={14} color={colors.foregroundMuted} />
      ) : current ? (
        <Icon name="CircleDot" size={14} color={colors.accent} />
      ) : (
        <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.foregroundMuted }} />
      );
    // The timeline runs between the marks, so nothing has to mask it and any surface shows through.
    const connector = (
      <>
        {first ? null : segment({ top: 0, height: center - MARK / 2 })}
        {last ? null : segment({ top: center + MARK / 2, bottom: 0 })}
      </>
    );
    return (
      <LineRow
        backdrop={connector}
        leading={
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={todoWords[todo.status]}
            style={{ width: MARK, height: MARK, alignItems: "center", justifyContent: "center" }}
          >
            {mark}
          </View>
        }
        title={label}
        titleLines={current ? 2 : 1}
        titleStyle={todo.status === "completed" ? { color: colors.foregroundMuted } : undefined}
        label={`${label}, ${todoWords[todo.status]}`}
      />
    );
  },
  (before, after) => before.first === after.first && before.last === after.last && sameFlat(before.todo, after.todo),
);

function EmptyState() {
  const { colors } = useView();
  return (
    <View style={{ alignItems: "center", gap: space.md, paddingVertical: space.xl * 2, paddingHorizontal: space.xl }}>
      <Icon name={AGENT_ICON} size={20} color={colors.foregroundMuted} />
      <Text style={[text("footnote", colors.foregroundMuted), { textAlign: "center" }]}>Background tasks appear here</Text>
    </View>
  );
}

interface TreeBodyProps {
  tree: SessionTree;
  main: MainAgentInfo;
  hostId: string;
  agentId: string;
  toggles: Toggles;
  onToggle(key: string, open: boolean): void;
  onOpen(open: OpenAgent): void;
}

/** One row of the list: a workflow block, an agent row or a task row. */
function renderItem(item: TreeItem, wiring: Wiring, now: number): ReactNode {
  switch (item.kind) {
    case "workflow":
      return <WorkflowBlock key={item.key} workflow={item.workflow} now={now} wiring={wiring} />;
    case "agent":
      return agentRow(wiring, null, item.node, item.key);
    case "task":
      return <TaskRow key={item.key} task={item.task} />;
  }
}

/**
 * The Main row, then Claude Code's two sections: "Background tasks", one list of workflows, subagents and background
 * tasks (running first, finished folded under a count while anything runs), and "Progress", the todo list. Empty
 * sections are left out.
 */
export function TreeBody({ tree, main, hostId, agentId, toggles, onToggle, onOpen }: TreeBodyProps) {
  const items = treeItems(tree);
  const wiring: Wiring = { hostId, agentId, sessionModel: tree.model, toggles, onToggle, onOpen };
  const now = parseTime(tree.generatedAt) ?? 0;
  const todosDone = tree.todos.filter((todo) => todo.status === "completed").length;
  const section = (id: string, title: string, summary: string, children: ReactNode) => {
    const key = `section:${id}`;
    const open = isOpen(toggles, key, true);
    return (
      <RailSection title={title} summary={summary} open={open} onToggle={() => onToggle(key, !open)}>
        {children}
      </RailSection>
    );
  };
  return (
    <View>
      <MainRow
        main={main}
        running={runningTotal(tree, visibleTasks(tree))}
        tokens={sumTokens(tree.totalTokens)}
        onOpen={() => onOpen({ childId: MAIN_CHILD_ID, runId: null, label: main.title })}
      />
      {items.length + tree.todos.length === 0 ? <EmptyState /> : null}
      {items.length > 0
        ? section(
            "tasks",
            "Background tasks",
            sectionSummary(items.map((item) => itemTiming(item).status)),
            <RowList
              scope="tasks"
              items={items}
              timing={itemTiming}
              fold={hasLive(items, itemTiming)}
              toggles={toggles}
              onToggle={onToggle}
              render={(item) => renderItem(item, wiring, now)}
            />,
          )
        : null}
      {tree.todos.length > 0
        ? section(
            "todos",
            "Progress",
            `${todosDone} of ${tree.todos.length}`,
            <View>
              {tree.todos.map((todo, index) => (
                <TodoRow key={`${index}-${todo.content}`} todo={todo} first={index === 0} last={index === tree.todos.length - 1} />
              ))}
            </View>,
          )
        : null}
    </View>
  );
}
