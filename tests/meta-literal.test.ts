import { describe, expect, it } from "vitest";
import { parseMetaLiteral, readWorkflowMeta } from "../server/meta-literal";

describe("workflow meta literal", () => {
  it("reads single quotes, unquoted keys, trailing commas, comments and backticks", () => {
    const script = `// header comment
import x from 'y'
export const meta = {
  name: 'ci-audit', // trailing comment
  /* block
     comment */
  "description": "Audit \\"CI\\" timings",
  phases: [
    { title: \`Audit\`, detail: 'parallel, it\\'s fast', },
    { title: 'Bench', },
    { 'title': "Critic", detail: \`multi
line\` },
  ],
}

const CTX = \`not \${meta}\`
`;
    expect(readWorkflowMeta(script)).toEqual({
      name: "ci-audit",
      description: 'Audit "CI" timings',
      phases: [
        { title: "Audit", detail: "parallel, it's fast" },
        { title: "Bench", detail: null },
        { title: "Critic", detail: "multi\nline" },
      ],
    });
  });

  it("reads numbers, booleans, null and escapes", () => {
    expect(parseMetaLiteral("export const meta = { a: 1.5e2, b: -3, c: 0x1f, d: true, e: null, f: '\\u00e9\\x41\\u{1F600}', 12: [ ] }")).toEqual({
      a: 150,
      b: -3,
      c: 31,
      d: true,
      e: null,
      f: "éA😀",
      "12": [],
    });
  });

  it("gives up on code that is not plain data", () => {
    expect(parseMetaLiteral("export const meta = { name: `x-${id}` }")).toBeNull();
    expect(parseMetaLiteral("export const meta = { ...base, name: 'x' }")).toBeNull();
    expect(parseMetaLiteral("export const meta = { name: build() }")).toBeNull();
    expect(parseMetaLiteral("export const meta = { name: 'unterminated }")).toBeNull();
    expect(parseMetaLiteral("const other = { name: 'x' }")).toBeNull();
    expect(readWorkflowMeta("export const meta = ['not', 'an', 'object']")).toBeNull();
  });

  it("skips malformed phases and keeps the rest", () => {
    expect(readWorkflowMeta("export const meta = { phases: [ 'Audit', { detail: 'no title' }, { title: '  Build ' } ] }")).toEqual({
      name: null,
      description: null,
      phases: [{ title: "Build", detail: null }],
    });
  });
});
