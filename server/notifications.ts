// <task-notification> blocks: Claude Code's message to the main agent when a background shell, a background
// subagent or a workflow ends. The same block can arrive through several carriers (a user line, a queue-operation,
// a queued_command attachment); callers dedupe by task id.

export interface TaskNotification {
  taskId: string;
  toolUseId: string | null;
  /** completed, failed, killed… as written. */
  status: string;
  summary: string | null;
  result: string | null;
}

const OPEN = "<task-notification>";
const CLOSE = "</task-notification>";

/**
 * Index of the close tag that balances the block opened at `start`. When the tags do not balance (a lone opening
 * tag quoted in a prompt or a result), the first close tag after it; -1 when there is none.
 */
function closingIndex(text: string, start: number): number {
  const first = text.indexOf(CLOSE, start);
  let depth = 0;
  let cursor = start;
  for (;;) {
    const close = text.indexOf(CLOSE, cursor);
    if (close < 0) return first;
    const open = text.indexOf(OPEN, cursor);
    if (open >= 0 && open < close) {
      depth += 1;
      cursor = open + OPEN.length;
    } else {
      depth -= 1;
      if (depth === 0) return close;
      cursor = close + CLOSE.length;
    }
  }
}

/** Bodies of the outermost blocks: a block quoted whole inside another one's result belongs to that result. */
function blockBodies(text: string): string[] {
  const bodies: string[] = [];
  let start = text.indexOf(OPEN);
  while (start >= 0) {
    const close = closingIndex(text, start);
    if (close < 0) break;
    bodies.push(text.slice(start + OPEN.length, close));
    start = text.indexOf(OPEN, close + CLOSE.length);
  }
  return bodies;
}

/** Text of the first <name> element; `outer` closes it at its last close tag, for results that quote markup. */
function tag(body: string, name: string, outer = false): string | null {
  const open = body.indexOf(`<${name}>`);
  if (open < 0) return null;
  const start = open + name.length + 2;
  const closeTag = `</${name}>`;
  const close = outer ? body.lastIndexOf(closeTag) : body.indexOf(closeTag, start);
  const value = (close < start ? body.slice(start) : body.slice(start, close)).trim();
  return value || null;
}

export function parseNotifications(text: string): TaskNotification[] {
  if (!text.includes(OPEN)) return [];
  const found: TaskNotification[] = [];
  for (const body of blockBodies(text)) {
    const taskId = tag(body, "task-id");
    const status = tag(body, "status")?.toLowerCase();
    // Real blocks carry an id and a one-word status; a prompt quoting the format ("completed|failed|…") does not count.
    if (!taskId || !status || !/^[A-Za-z0-9_-]+$/.test(taskId) || !/^[a-z_]+$/.test(status)) continue;
    found.push({
      taskId,
      toolUseId: tag(body, "tool-use-id"),
      status,
      summary: tag(body, "summary"),
      result: tag(body, "result", true),
    });
  }
  return found;
}

export type TerminalStatus = "done" | "failed" | "stopped";

/** The run status a notification status means; null when it is not an end (a progress update). */
export function terminalStatus(status: string): TerminalStatus | null {
  if (status === "completed" || status === "success" || status === "succeeded") return "done";
  if (status === "failed" || status === "error") return "failed";
  if (status === "killed" || status === "stopped" || status === "cancelled" || status === "canceled") return "stopped";
  return null;
}
