import { z } from "zod";

/** The agent whose steps the panel shows. childId "main" is the main session; runId is set for workflow agents. */
const openAgentSchema = z.object({ childId: z.string(), runId: z.string().nullable(), label: z.string() });
export type OpenAgent = z.infer<typeof openAgentSchema>;

/** Persisted per tab, so a restored tab reopens the same agent. */
export const panelStateSchema = z.object({ open: openAgentSchema.nullable() });
export type PanelState = z.infer<typeof panelStateSchema>;

export const MAIN_CHILD_ID = "main";
