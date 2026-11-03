import type { PluginServerContext } from "@getpaseo/plugin/server";
import { defaultEnv } from "./server/env";
import { createHandlers } from "./server/rpc";
import { SessionStore } from "./server/session";
import { agentStepsRpc, runsOverviewRpc, sessionTreeRpc } from "./shared/contract";

export default function contribute(server: PluginServerContext) {
  // One store for the plugin's lifetime: its caches make the 2-second polls read only appended bytes.
  const handlers = createHandlers(new SessionStore(defaultEnv()));
  server.handle(sessionTreeRpc, handlers.tree);
  server.handle(agentStepsRpc, handlers.steps);
  server.handle(runsOverviewRpc, handlers.overview);
  return () => {};
}
