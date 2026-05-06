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

  test("rejects multi-block output with no unique ts tag (ambiguous — first is example or stale)", () => {
    const raw = "```ts\nfirst\n```\nthen\n```ts\nsecond\n```";
    expect(parseRefinementOutput(raw)).toBeNull();
  });

  test("accepts multi-block output when exactly one block is ts-tagged", () => {
    const raw = "Example:\n```\nold\n```\nFinal:\n```ts\nnew code\n```";
    expect(parseRefinementOutput(raw)).toBe("new code");
  });

  test("rejects multi-block output when no block carries a ts tag", () => {
    const raw = "```\none\n```\nand\n```\ntwo\n```";
    expect(parseRefinementOutput(raw)).toBeNull();
  });

  test("rejects multi-block output even when one block is js-tagged (only ts/typescript counts)", () => {
    const raw = "```js\nold\n```\n```\nplain\n```";
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

  test("returns null for non-string input (no throw)", () => {
    expect(parseRefinementOutput(null)).toBeNull();
    expect(parseRefinementOutput(undefined)).toBeNull();
    expect(parseRefinementOutput({ choices: [] })).toBeNull();
    expect(parseRefinementOutput(42)).toBeNull();
  });
});
