import type { PluginTheme } from "@getpaseo/plugin";
import { Platform, StyleSheet, type TextStyle, type ViewStyle } from "react-native";

export type Colors = PluginTheme["colors"];

/** Spacing steps of Claude Code's compact density. Nothing outside this list is used. */
export const space = { xxs: 2, xs: 4, sm: 6, md: 8, lg: 12, xl: 16 } as const;

/**
 * Row geometry of Claude Code's subagent sidebar: a 26 px first line, a 20 px leading glyph box, an 8 px gap to the
 * title and a 24 px end slot for the chevron. Phones keep a 44 px touch row.
 */
export const row = { line: 26, touch: 44, glyph: 20, gap: 8, padX: 4, endSlot: 24, radius: 6 } as const;

/** Where a row's title starts: its padding, the glyph box and the gap. Second lines and bodies indent to it. */
export const titleIndent = row.padX + row.glyph + row.gap;

/** The panel's own padding: with a row's 4 px padding, text sits 10 px from the edge. */
export const panePadX = space.sm;

/** Wide tabs keep rows readable instead of stretching them across the screen. */
export const maxContentWidth = 720;

/** One pixel on web, the thinnest line the screen can draw on native. */
export const hairline = Platform.OS === "web" ? 1 : StyleSheet.hairlineWidth;

/**
 * Three sizes: the detail view's title, row titles (body) and every secondary line, time and heading (footnote).
 * The typeface stays Paseo's own; only code blocks switch to mono. Two weights, no bold.
 */
const typeScale = {
  title: { fontSize: 14, lineHeight: 20 },
  body: { fontSize: 13, lineHeight: 19 },
  footnote: { fontSize: 12, lineHeight: 16 },
} as const;

/** Line heights of row titles and footnotes, for centring them on the 26 px first line. */
export const bodyLine = typeScale.body.lineHeight;
export const footnoteLine = typeScale.footnote.lineHeight;

type TypeRole = keyof typeof typeScale;
type Weight = "400" | "500";

/** The only way text gets a size: a role, a colour token, a weight. */
export function text(role: TypeRole, color: string, weight: Weight = "400"): TextStyle {
  return { ...typeScale[role], fontWeight: weight, color };
}

/** Equal-width digits so live counters and columns do not jitter. */
export const tabular: TextStyle = { fontVariant: ["tabular-nums"] };

const monoFamily = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

/** Tool inputs, results and the step connector. */
export function mono(color: string): TextStyle {
  return { fontFamily: monoFamily, fontSize: 12, lineHeight: 17, color };
}

/** Accent marks running work, links and the keyboard focus ring; nothing else. */
export function focusRing(colors: Colors): ViewStyle {
  return { outlineColor: colors.accent, outlineStyle: "solid", outlineWidth: 2 };
}
