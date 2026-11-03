import { open, stat } from "node:fs/promises";

// Incremental JSONL parsing. Transcripts grow while agents run and are polled every couple of seconds, so each
// file keeps a cursor: bytes already parsed, the partial last line, and the reduced state. A poll reads only the
// bytes appended since, and starts over when the file shrank or was replaced.

export type JsonObject = Record<string, unknown>;

export interface Reducer<State> {
  create(): State;
  apply(state: State, line: JsonObject): void;
  /** Approximate retained characters, for the cache budget. */
  weight(state: State): number;
}

export interface FileSnapshot<State> {
  state: State;
  mtimeMs: number;
  birthtimeMs: number;
}

interface Cursor<State> {
  dev: number;
  ino: number;
  mtimeMs: number;
  birthtimeMs: number;
  offset: number;
  carry: Buffer;
  state: State;
}

const CHUNK_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

/** At most `limit` tasks at a time; the rest wait in order. */
export class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

/** Open files and read buffers of the reads a panel waits on (tree.get, agent.steps). */
export const fileGate = new Gate(16);

export interface CacheLimits {
  maxFiles: number;
  maxWeight: number;
}

export class JsonlCache<State> {
  private readonly cursors = new Map<string, Cursor<State>>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly reducer: Reducer<State>,
    private readonly limits: CacheLimits = { maxFiles: 400, maxWeight: 96 * 1024 * 1024 },
    /** Readers that must not starve the panel's reads (the overview) get a smaller gate of their own. */
    private readonly gate: Gate = fileGate,
  ) {}

  /** Current state of the file, or null when it does not exist or cannot be read. */
  read(path: string): Promise<FileSnapshot<State> | null> {
    // One update per file at a time: two overlapping polls must not both apply the same appended bytes.
    const previous = this.locks.get(path) ?? Promise.resolve();
    const next = previous.then(() => this.update(path));
    const settled = next.catch(() => null);
    this.locks.set(path, settled);
    void settled.then(() => {
      if (this.locks.get(path) === settled) this.locks.delete(path);
    });
    return next;
  }

  private async update(path: string): Promise<FileSnapshot<State> | null> {
    let info;
    try {
      info = await stat(path);
    } catch {
      this.cursors.delete(path);
      return null;
    }
    if (!info.isFile()) return null;
    let cursor = this.cursors.get(path);
    if (!cursor || cursor.ino !== info.ino || cursor.dev !== info.dev || info.size < cursor.offset + cursor.carry.length) {
      cursor = {
        dev: info.dev,
        ino: info.ino,
        mtimeMs: 0,
        birthtimeMs: info.birthtimeMs,
        offset: 0,
        carry: Buffer.alloc(0),
        state: this.reducer.create(),
      };
    }
    // Most recently used last, for eviction.
    this.cursors.delete(path);
    this.cursors.set(path, cursor);
    const end = info.size;
    const start = cursor.offset + cursor.carry.length;
    if (end > start) {
      try {
        const current = cursor;
        await this.gate.run(() => this.consume(path, current, start, end));
      } catch {
        // Unreadable right now (permissions, vanished mid-read): keep what was parsed.
      }
    }
    cursor.mtimeMs = info.mtimeMs;
    this.evict(path);
    return { state: cursor.state, mtimeMs: cursor.mtimeMs, birthtimeMs: cursor.birthtimeMs };
  }

  private async consume(path: string, cursor: Cursor<State>, start: number, end: number): Promise<void> {
    const handle = await open(path, "r");
    try {
      let position = start;
      while (position < end) {
        const length = Math.min(CHUNK_BYTES, end - position);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const data = cursor.carry.length ? Buffer.concat([cursor.carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
        const last = data.lastIndexOf(NEWLINE);
        if (last < 0) {
          cursor.carry = Buffer.from(data);
          continue;
        }
        // Split on bytes: a newline byte never occurs inside a multi-byte UTF-8 character.
        const complete = data.subarray(0, last).toString("utf8");
        cursor.carry = Buffer.from(data.subarray(last + 1));
        cursor.offset = position - cursor.carry.length;
        for (const line of complete.split("\n")) this.applyLine(cursor.state, line);
      }
    } finally {
      await handle.close();
    }
  }

  private applyLine(state: State, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    try {
      this.reducer.apply(state, parsed as JsonObject);
    } catch {
      // A line with an unexpected shape is skipped; the reducers guard their reads, this is the last net.
    }
  }

  private evict(keep: string): void {
    if (this.cursors.size <= 1) return;
    let weight = 0;
    for (const cursor of this.cursors.values()) weight += this.reducer.weight(cursor.state) + cursor.carry.length;
    for (const [path, cursor] of this.cursors) {
      if (this.cursors.size <= this.limits.maxFiles && weight <= this.limits.maxWeight) break;
      if (path === keep) continue;
      weight -= this.reducer.weight(cursor.state) + cursor.carry.length;
      this.cursors.delete(path);
    }
  }
}
