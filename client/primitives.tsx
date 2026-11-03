import { Icon } from "@getpaseo/plugin/client/ui";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { useSecondTick } from "./clock";
import { elapsedMs, formatDuration, formatElapsed } from "./format";
import { toneColor, type Look } from "./looks";
import type { CellState, Part, Trailing } from "./rows";
import { bodyLine, focusRing, mono, row, space, tabular, text, titleIndent, type Colors } from "./theme";
import { useView } from "./view";

/** Hover (web) and keyboard focus. A focus that arrives under the pointer is a click, so it draws no ring. */
function useInteraction() {
  const pointerOver = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);
  const handlers = {
    onHoverIn: () => {
      pointerOver.current = true;
      setHovered(true);
    },
    onHoverOut: () => {
      pointerOver.current = false;
      setHovered(false);
    },
    onFocus: () => setFocusVisible(!pointerOver.current),
    onBlur: () => setFocusVisible(false),
  };
  return { hovered, focusVisible, handlers };
}

/** Claude Code's fill-ghost-hover and alpha-2: the ink colour, faint, so they show on any surface behind the panel. */
const HOVER_INK = 0.06;
const STRONG_INK = 0.1;

/** A faint layer of ink over the area of its parent, under its content. */
function Ink({ opacity, radius = row.radius }: { opacity: number; radius?: number }) {
  const { colors } = useView();
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.foreground, opacity, borderRadius: radius, pointerEvents: "none" }]} />;
}

interface TouchableProps {
  onPress(): void;
  /** The full text for screen readers; the visible text is clamped. */
  label: string;
  hint?: string;
  /** Set for a fold: its expanded state. */
  expanded?: boolean;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}

/** A pressable area with the sidebar's feedback: ghost ink on hover, stronger while pressed, ring on focus. */
export function Touchable({ onPress, label, hint, expanded, style, children }: TouchableProps) {
  const { colors } = useView();
  const { hovered, focusVisible, handlers } = useInteraction();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      {...handlers}
      style={[style, focusVisible ? focusRing(colors) : undefined]}
    >
      {({ pressed }) => (
        <>
          {pressed || hovered ? <Ink opacity={pressed ? STRONG_INK : HOVER_INK} /> : null}
          {children}
        </>
      )}
    </Pressable>
  );
}

/** A row's leading 16 px icon: what the row is, in the secondary tint. Decorative: the row's label names it. */
export function TypeIcon({ name }: { name: string }) {
  const { colors } = useView();
  return <Icon name={name} size={16} color={colors.foregroundMuted} />;
}

/** A state glyph whose word is its accessible name. */
export function Glyph({ look, size = 14 }: { look: Look; size?: number }) {
  const { colors } = useView();
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={look.word}>
      <Icon name={look.icon} size={size} color={toneColor(look.tone, colors)} />
    </View>
  );
}

/** A right-pointing chevron that turns down when open, muted unless its toggle is hovered. */
export function Chevron({ open, size, color }: { open: boolean; size: number; color?: string }) {
  const { colors } = useView();
  return (
    <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
      <Icon name="ChevronRight" size={size} color={color ?? colors.foregroundMuted} />
    </View>
  );
}

/** Elapsed time: the short live form while it runs (ticking on the shared clock while shown), the full duration after. */
export function Elapsed({ startedAt, endedAt, live }: { startedAt: string | null; endedAt: string | null; live: boolean }) {
  const { colors, shown } = useView();
  const now = useSecondTick(live && shown);
  if (!live && endedAt === null) return null;
  const ms = elapsedMs(startedAt, live ? null : endedAt, now);
  if (ms === null) return null;
  return <Text style={[text("footnote", colors.foregroundMuted), tabular]}>{live ? formatElapsed(ms) : formatDuration(ms)}</Text>;
}

/** What sits right of a row's title: the live time, the finished duration, a status word, or nothing. */
export function TrailingText({ trailing, startedAt }: { trailing: Trailing; startedAt: string | null }) {
  const { colors } = useView();
  if (trailing === null) return null;
  if (trailing.kind === "live") return <Elapsed startedAt={startedAt} endedAt={null} live />;
  const [words, color] = trailing.kind === "duration" ? [trailing.text, colors.foregroundMuted] : [trailing.word, toneColor(trailing.tone, colors)];
  return <Text style={[text("footnote", color), tabular]}>{words}</Text>;
}

/** A row's second line: its parts 8 px apart on one line, no separators; the last part truncates. */
export function SecondLine({ parts }: { parts: readonly Part[] }) {
  const { colors } = useView();
  return (
    <View style={{ flexDirection: "row", gap: space.md, minWidth: 0, overflow: "hidden" }}>
      {parts.map((part, index) => (
        <Text
          key={index}
          numberOfLines={1}
          style={[text("footnote", toneColor(part.tone, colors)), tabular, index === parts.length - 1 ? { flexShrink: 1, minWidth: 0 } : { flexShrink: 0 }]}
        >
          {part.text}
        </Text>
      ))}
    </View>
  );
}

interface LineRowProps {
  /** The 20 px leading box: a type icon, or a todo mark. */
  leading: ReactNode;
  title: string;
  /** Merged over the 13 px primary title: a muted colour, tabular digits. */
  titleStyle?: StyleProp<TextStyle>;
  titleLines?: number;
  trailing?: ReactNode;
  second?: ReactNode;
  /** Drawn behind the row, such as the todo timeline. */
  backdrop?: ReactNode;
  /** A pressable row gets the end chevron. */
  onPress?: () => void;
  /** Set for a row that expands in place: the chevron turns down while expanded. */
  expanded?: boolean;
  /** The row's full text for screen readers; the visible text is clamped. */
  label: string;
  hint?: string;
}

/**
 * Claude Code's sidebar line row: a 26 px first line with the type icon, the title and a muted trailing time or word,
 * an optional second line under the title, and a 24 px end slot that holds the chevron of a pressable row (kept
 * empty otherwise, so trailing columns line up). No card, no border; hover and press ink the whole row.
 */
export function LineRow({ leading, title, titleStyle, titleLines = 1, trailing, second, backdrop, onPress, expanded, label, hint }: LineRowProps) {
  const { colors, compact } = useView();
  const titlePad = (row.line - bodyLine) / 2;
  const base: ViewStyle = {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: row.padX,
    paddingVertical: compact ? (row.touch - row.line) / 2 : 0,
    borderRadius: row.radius,
  };
  const content = (
    <>
      {backdrop}
      <View style={{ width: row.glyph, height: row.line, alignItems: "center", justifyContent: "center" }}>{leading}</View>
      <View style={{ flex: 1, minWidth: 0, marginLeft: row.gap, paddingBottom: second ? space.xs : 0 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.lg }}>
          <Text numberOfLines={titleLines} style={[text("body", colors.foreground), { flex: 1, minWidth: 0, paddingVertical: titlePad }, titleStyle]}>
            {title}
          </Text>
          {trailing ? <View style={{ height: row.line, justifyContent: "center" }}>{trailing}</View> : null}
        </View>
        {second}
      </View>
      <View style={{ width: row.endSlot, height: row.line, alignItems: "center", justifyContent: "center" }}>
        {onPress ? <Chevron open={expanded === true} size={14} /> : null}
      </View>
    </>
  );
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={label} style={base}>
        {content}
      </View>
    );
  }
  return (
    <Touchable onPress={onPress} label={label} hint={hint} expanded={expanded} style={base}>
      {content}
    </Touchable>
  );
}

interface RailSectionProps {
  title: string;
  /** Shown right of the title while the section is collapsed. */
  summary: string;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}

/** A collapsible sidebar section: a 26 px header (title, chevron, summary while collapsed), then its rows. */
export function RailSection({ title, summary, open, onToggle, children }: RailSectionProps) {
  const { colors, compact } = useView();
  return (
    <View style={{ paddingVertical: space.md }}>
      <Touchable
        onPress={onToggle}
        label={`${title}, ${summary}`}
        expanded={open}
        style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: compact ? row.touch : row.line, paddingHorizontal: row.padX, borderRadius: row.radius }}
      >
        <Text style={text("footnote", colors.foreground, "500")}>{title}</Text>
        <Chevron open={open} size={12} />
        {open ? null : (
          <Text numberOfLines={1} style={[text("footnote", colors.foregroundMuted), tabular, { marginLeft: "auto", paddingLeft: space.sm, flexShrink: 1 }]}>
            {summary}
          </Text>
        )}
      </Touchable>
      {open ? <View>{children}</View> : null}
    </View>
  );
}

interface FootnoteToggleProps {
  label: string;
  onPress(): void;
  /** Set for a fold ("3 finished"): its state, drawn by the 14 px chevron after the text. */
  expanded?: boolean;
  hint?: string;
}

/**
 * Claude Code's footnote toggle, aligned with the row titles: muted 12 px text, primary on hover, on a 20 px line
 * (44 px on phones). "Show more" under a long list, "{n} finished" with a chevron over the folded rows.
 */
export function FootnoteToggle({ label, onPress, expanded, hint }: FootnoteToggleProps) {
  const { colors, compact } = useView();
  const { hovered, focusVisible, handlers } = useInteraction();
  const color = hovered ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      {...handlers}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          alignSelf: "flex-start",
          gap: space.xs,
          minHeight: compact ? row.touch : 20,
          marginLeft: titleIndent - row.padX,
          paddingHorizontal: row.padX,
          borderRadius: row.radius,
        },
        focusVisible ? focusRing(colors) : undefined,
      ]}
    >
      <Text style={[text("footnote", color), tabular]}>{label}</Text>
      {expanded === undefined ? null : <Chevron open={expanded} size={14} color={color} />}
    </Pressable>
  );
}

/** A footnote link ("View transcript", "Retry") in the text colour, underlined on hover and keyboard focus. */
export function TextLink({ label, onPress, accessibilityLabel }: { label: string; onPress(): void; accessibilityLabel?: string }) {
  const { colors, compact } = useView();
  const { hovered, focusVisible, handlers } = useInteraction();
  const slop = compact ? space.lg : space.xs;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      hitSlop={{ top: slop, bottom: slop, left: space.md, right: space.md }}
      {...handlers}
      style={[{ alignSelf: "flex-start" }, focusVisible ? focusRing(colors) : undefined]}
    >
      <Text style={[text("footnote", colors.foreground), hovered || focusVisible ? { textDecorationLine: "underline" } : undefined]}>{label}</Text>
    </Pressable>
  );
}

/** A muted section heading of the detail view, with its count and an optional action on the right. */
export function Heading({ title, count, right }: { title: string; count?: string; right?: ReactNode }) {
  const { colors } = useView();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 24, paddingHorizontal: row.padX }}>
      <Text accessibilityRole="header" style={[text("footnote", colors.foregroundMuted), tabular, { flexShrink: 1 }]}>
        {count === undefined ? title : `${title} ${count}`}
      </Text>
      {right ? <View style={{ marginLeft: "auto" }}>{right}</View> : null}
    </View>
  );
}

/** One plain sentence, optionally with a state glyph and a retry. Used for empty, not-found and error states. */
export function Notice({ sentence, look, onRetry }: { sentence: string; look?: Look; onRetry?: () => void }) {
  const { colors } = useView();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: row.gap, paddingHorizontal: row.padX, paddingVertical: space.xs }}>
      {look ? (
        <View style={{ width: row.glyph, height: bodyLine, alignItems: "center", justifyContent: "center" }}>
          <Glyph look={look} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
        <Text selectable style={text("body", colors.foregroundMuted)}>
          {sentence}
        </Text>
        {onRetry ? <TextLink label="Retry" onPress={onRetry} /> : null}
      </View>
    </View>
  );
}

/** A selectable monospace block (tool inputs, results) on Claude Code's alpha-2 ink. */
export function MonoBlock({ value, numberOfLines }: { value: string; numberOfLines?: number }) {
  const { colors } = useView();
  return (
    <View style={{ borderRadius: 8, paddingVertical: 5, paddingHorizontal: space.md }}>
      <Ink opacity={STRONG_INK} radius={8} />
      <Text selectable numberOfLines={numberOfLines} style={mono(colors.foreground)}>
        {value}
      </Text>
    </View>
  );
}

/** Up to this many agents get a cell; eight rows of a sidebar hold about that many. */
const MAX_CELLS = 240;
const CELL = 6;

function cellStyle(state: CellState, colors: Colors): ViewStyle {
  switch (state) {
    case "done":
      return { backgroundColor: colors.foregroundMuted, opacity: 0.45 };
    case "running":
      return { backgroundColor: colors.accent };
    case "stalled":
      return { backgroundColor: colors.statusWarning };
    case "failed":
      return { backgroundColor: colors.statusDanger };
    case "stopped":
    case "pending":
      return { borderWidth: 1, borderColor: colors.foregroundMuted, opacity: 0.45 };
  }
}

/** A workflow's agents as 6 px cells, 2 px apart: done neutral, running accent, stalled warning, failed danger. */
export function Cells({ cells, summary }: { cells: readonly CellState[]; summary: string }) {
  const { colors } = useView();
  if (cells.length === 0) return null;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={summary}
      style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xxs, paddingTop: space.xs, maxHeight: 8 * CELL + 7 * space.xxs + space.xs, overflow: "hidden" }}
    >
      {cells.slice(0, MAX_CELLS).map((state, index) => (
        <View key={index} style={[{ width: CELL, height: CELL, borderRadius: 2 }, cellStyle(state, colors)]} />
      ))}
    </View>
  );
}
