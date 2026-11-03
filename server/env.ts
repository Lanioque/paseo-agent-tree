import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Where the plugin reads from. Tests point it at a temporary directory. */
export interface Env {
  home: string;
  /** Paseo daemon home: agents/<cwd-dir>/<agentId>.json. */
  paseoHome: string;
  /** Claude Code config directories, strongest first: <dir>/projects/<projDir>/<sessionId>.jsonl. */
  claudeDirs: string[];
}

function expand(raw: string | undefined, home: string): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  return isAbsolute(value) ? resolve(value) : null;
}

export function defaultEnv(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): Env {
  const dirs = [expand(env.CLAUDE_CONFIG_DIR, home), join(home, ".claude"), join(home, ".config", "claude")];
  return {
    home,
    paseoHome: expand(env.PASEO_HOME, home) ?? join(home, ".paseo"),
    claudeDirs: dirs.filter((dir, index): dir is string => dir !== null && dirs.indexOf(dir) === index),
  };
}

/** Claude Code's project directory name for a cwd: every character outside [A-Za-z0-9] becomes "-". */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Ids that end up in file names: no separators, no dots, nothing that walks out of a directory. */
export function safeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
