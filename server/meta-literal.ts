// Reads `export const meta = { … }` from a Workflow script without running it. The literal is plain data:
// objects, arrays, quoted or backtick strings (no ${} interpolation), numbers, true/false/null, unquoted keys,
// trailing commas and comments. Anything else (spreads, calls, variables) makes the parse give up.

export interface WorkflowPhaseMeta {
  title: string;
  detail: string | null;
}

export interface WorkflowMeta {
  name: string | null;
  description: string | null;
  phases: WorkflowPhaseMeta[];
}

type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };

class LiteralError extends Error {}

class Parser {
  private index: number;

  constructor(private readonly source: string, start: number) {
    this.index = start;
  }

  value(): Literal {
    this.skip();
    const char = this.source[this.index];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === "'" || char === '"' || char === "`") return this.string(char);
    if (char !== undefined && /[-+.\d]/.test(char)) return this.number();
    const word = this.identifier();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null" || word === "undefined") return null;
    throw new LiteralError(`unexpected ${word || char || "end"}`);
  }

  private object(): { [key: string]: Literal } {
    const result: { [key: string]: Literal } = {};
    this.index += 1;
    for (;;) {
      this.skip();
      if (this.source[this.index] === "}") {
        this.index += 1;
        return result;
      }
      const key = this.key();
      this.skip();
      if (this.source[this.index] !== ":") throw new LiteralError("expected :");
      this.index += 1;
      result[key] = this.value();
      this.separator("}");
    }
  }

  private array(): Literal[] {
    const result: Literal[] = [];
    this.index += 1;
    for (;;) {
      this.skip();
      if (this.source[this.index] === "]") {
        this.index += 1;
        return result;
      }
      result.push(this.value());
      this.separator("]");
    }
  }

  /** After an entry: a comma, or the closing bracket (left for the caller). */
  private separator(close: string): void {
    this.skip();
    const char = this.source[this.index];
    if (char === ",") this.index += 1;
    else if (char !== close) throw new LiteralError(`expected , or ${close}`);
  }

  private key(): string {
    const char = this.source[this.index];
    if (char === "'" || char === '"' || char === "`") return this.string(char);
    if (char !== undefined && /\d/.test(char)) return String(this.number());
    const word = this.identifier();
    if (!word) throw new LiteralError("expected a key");
    return word;
  }

  private identifier(): string {
    const match = /^[A-Za-z_$][\w$]*/.exec(this.source.slice(this.index, this.index + 256));
    if (!match) return "";
    this.index += match[0].length;
    return match[0];
  }

  private number(): number {
    const match = /^[-+]?(?:0[xX][\da-fA-F]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][-+]?\d+)?)/.exec(this.source.slice(this.index, this.index + 64));
    if (!match) throw new LiteralError("bad number");
    this.index += match[0].length;
    const value = Number(match[0].replace(/_/g, ""));
    if (Number.isNaN(value)) throw new LiteralError("bad number");
    return value;
  }

  private string(quote: string): string {
    let out = "";
    this.index += 1;
    for (;;) {
      const char = this.source[this.index];
      if (char === undefined) throw new LiteralError("unterminated string");
      this.index += 1;
      if (char === quote) return out;
      if (char === "\\") {
        out += this.escape();
        continue;
      }
      if (quote === "`" && char === "$" && this.source[this.index] === "{") throw new LiteralError("template interpolation");
      if (quote !== "`" && char === "\n") throw new LiteralError("newline in string");
      out += char;
    }
  }

  private escape(): string {
    const char = this.source[this.index];
    this.index += 1;
    switch (char) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "0":
        return "\0";
      case "\n":
        return "";
      case "\r":
        if (this.source[this.index] === "\n") this.index += 1;
        return "";
      case "x":
        return this.codePoint(/^[\da-fA-F]{2}/);
      case "u":
        if (this.source[this.index] === "{") {
          const end = this.source.indexOf("}", this.index);
          if (end < 0) throw new LiteralError("bad escape");
          const hex = this.source.slice(this.index + 1, end);
          this.index = end + 1;
          return String.fromCodePoint(Number.parseInt(hex, 16));
        }
        return this.codePoint(/^[\da-fA-F]{4}/);
      case undefined:
        throw new LiteralError("unterminated string");
      default:
        return char;
    }
  }

  private codePoint(pattern: RegExp): string {
    const match = pattern.exec(this.source.slice(this.index, this.index + 4));
    if (!match) throw new LiteralError("bad escape");
    this.index += match[0].length;
    return String.fromCodePoint(Number.parseInt(match[0], 16));
  }

  /** Whitespace, // and block comments. */
  private skip(): void {
    for (;;) {
      const rest = this.source.slice(this.index, this.index + 2);
      if (/^\s/.test(rest)) this.index += 1;
      else if (rest === "//") {
        const end = this.source.indexOf("\n", this.index);
        this.index = end < 0 ? this.source.length : end + 1;
      } else if (rest === "/*") {
        const end = this.source.indexOf("*/", this.index + 2);
        if (end < 0) throw new LiteralError("unterminated comment");
        this.index = end + 2;
      } else return;
    }
  }
}

/** The value assigned by `export const meta =` (or `const meta =`), or null when absent or not plain data. */
export function parseMetaLiteral(script: string): Literal | null {
  const match = /(?:^|[\s;])(?:export\s+)?const\s+meta\s*(?::[^=]*)?=\s*/.exec(script);
  if (!match) return null;
  try {
    return new Parser(script, match.index + match[0].length).value();
  } catch (error) {
    if (error instanceof LiteralError) return null;
    throw error;
  }
}

const text = (value: Literal | undefined): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** name, description and phases of a Workflow script; null when the script has no readable meta. */
export function readWorkflowMeta(script: string): WorkflowMeta | null {
  const literal = parseMetaLiteral(script);
  if (literal === null || typeof literal !== "object" || Array.isArray(literal)) return null;
  const phases: WorkflowPhaseMeta[] = [];
  const declared = literal.phases;
  if (Array.isArray(declared)) {
    for (const phase of declared) {
      if (phase === null || typeof phase !== "object" || Array.isArray(phase)) continue;
      const title = text(phase.title);
      if (title) phases.push({ title, detail: text(phase.detail) });
    }
  }
  return { name: text(literal.name), description: text(literal.description), phases };
}
