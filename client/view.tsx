import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import type { Colors } from "./theme";

/** What every row needs from its surface: the theme colours, the density and whether anyone can see it. */
export interface ViewState {
  colors: Colors;
  /** Phone: 44 px touch rows. */
  compact: boolean;
  /**
   * False while the surface is mounted but hidden: Paseo keeps recent tabs and unfocused workspaces mounted under
   * display:none. Hidden surfaces stop polling and stop their clocks.
   */
  shown: boolean;
}

const ViewContext = createContext<ViewState | null>(null);

export function ViewProvider({ value, children }: { value: ViewState; children: ReactNode }) {
  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}

export function useView(): ViewState {
  const view = useContext(ViewContext);
  if (view === null) throw new Error("Agent tree component rendered outside its panel or screen");
  return view;
}

/**
 * Whether the surface is on screen, from its root's onLayout: Paseo hides a retained tab or an unfocused workspace
 * with display:none, which lays it out at 0×0. Until the first layout it counts as shown.
 */
export function useShown(): { shown: boolean; onLayout(event: LayoutChangeEvent): void } {
  const [shown, setShown] = useState(true);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setShown(width > 0 && height > 0);
  }, []);
  return { shown, onLayout };
}
