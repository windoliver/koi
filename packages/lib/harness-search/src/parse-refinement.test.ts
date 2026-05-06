import { describe, expect, test } from "bun:test";
import { parseRefinementOutput } from "./parse-refinement.js";

describe("parseRefinementOutput", () => {
  test("extracts from typescript fence", () => {
    const raw = "Here:\n```typescript\nconst x = 1;\n```\ndone";
    expect(parseRefinementOutput(raw)).toBe("const x = 1;");
  });

  test("extracts from ts fence", () => {
    const raw = "```ts\nexport const y = 2;\n```";
    expect(parseRefinementOutput(raw)).toBe("export const y = 2;");
  });

  test("extracts from javascript fence", () => {
    const raw = "```javascript\nlet z = 3;\n```";
    expect(parseRefinementOutput(raw)).toBe("let z = 3;");
  });

  test("extracts from unlabelled fence", () => {
    const raw = "```\nplain code\n```";
    expect(parseRefinementOutput(raw)).toBe("plain code");
  });

  test("rejects multi-block output with no unique source-language tag (two ts blocks — ambiguous)", () => {
    const raw = "```ts\nfirst\n```\nthen\n```ts\nsecond\n```";
    expect(parseRefinementOutput(raw)).toBeNull();
  });

  test("accepts multi-block output when exactly one block is ts-tagged", () => {
    const raw = "Example:\n```\nold\n```\nFinal:\n```ts\nnew code\n```";
    expect(parseRefinementOutput(raw)).toBe("new code");
  });

  test("accepts multi-block output when exactly one block is js-tagged", () => {
    // Regression: multi-block disambiguation previously only accepted
    // ts/typescript, forcing refine_failed on valid JS-only refiners.
    const raw = "Example:\n```\nold\n```\nFinal:\n```js\nnew code\n```";
    expect(parseRefinementOutput(raw)).toBe("new code");
  });

  test("accepts multi-block output when exactly one block is javascript-tagged", () => {
    const raw = "Old:\n```\nstale\n```\nNew:\n```javascript\nfresh\n```";
    expect(parseRefinementOutput(raw)).toBe("fresh");
  });

  test("rejects multi-block output when no block carries a source-language tag", () => {
    const raw = "```\none\n```\nand\n```\ntwo\n```";
    expect(parseRefinementOutput(raw)).toBeNull();
  });

  test("rejects multi-block output when both ts AND js are tagged (ambiguous)", () => {
    const raw = "```ts\nfirst\n```\n```js\nsecond\n```";
    expect(parseRefinementOutput(raw)).toBeNull();
  });

  test("returns null when no fence", () => {
    expect(parseRefinementOutput("just prose")).toBeNull();
  });

  test("returns null for empty fence", () => {
    expect(parseRefinementOutput("```ts\n   \n```")).toBeNull();
  });

  test("rejects single-block non-source tag (json)", () => {
    expect(parseRefinementOutput('```json\n{"x":1}\n```')).toBeNull();
  });

  test("rejects single-block non-source tag (diff)", () => {
    expect(parseRefinementOutput("```diff\n+ line\n- line\n```")).toBeNull();
  });

  test("rejects single-block non-source tag (bash)", () => {
    expect(parseRefinementOutput("```bash\necho hi\n```")).toBeNull();
  });

  test("rejects single-block non-source tag (text/md)", () => {
    expect(parseRefinementOutput("```text\nplain\n```")).toBeNull();
    expect(parseRefinementOutput("```md\n# title\n```")).toBeNull();
  });

  test("accepts language tag followed by markdown info string (filename)", () => {
    // Common LLM output pattern: ```ts title="candidate.ts"
    const raw = '```ts title="candidate.ts"\nexport const x = 1;\n```';
    expect(parseRefinementOutput(raw)).toBe("export const x = 1;");
  });

  test("accepts language tag followed by space-separated extra info", () => {
    const raw = "```typescript app.ts\nconst y = 2;\n```";
    expect(parseRefinementOutput(raw)).toBe("const y = 2;");
  });

  test("multi-block path picks tagged block even when info string has filename", () => {
    const raw = 'Old:\n```\nstale\n```\nNew:\n```ts title="v2.ts"\nfresh\n```';
    expect(parseRefinementOutput(raw)).toBe("fresh");
  });

  test("does not truncate at triple-backticks embedded inside string literal", () => {
    // The opening fence is on its own line, the closing fence is on
    // its own line — the inline triple-backticks belong to the body.
    const raw = '```ts\nconst s = "before```after";\nconst t = 1;\n```';
    const out = parseRefinementOutput(raw);
    expect(out).toContain("before```after");
    expect(out).toContain("const t = 1;");
  });

  test("returns null for non-string input (no throw)", () => {
    expect(parseRefinementOutput(null)).toBeNull();
    expect(parseRefinementOutput(undefined)).toBeNull();
    expect(parseRefinementOutput({ choices: [] })).toBeNull();
    expect(parseRefinementOutput(42)).toBeNull();
  });
});
