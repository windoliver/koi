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

  test("returns first block when multiple present", () => {
    const raw = "```ts\nfirst\n```\nthen\n```ts\nsecond\n```";
    expect(parseRefinementOutput(raw)).toBe("first");
  });

  test("returns null when no fence", () => {
    expect(parseRefinementOutput("just prose")).toBeNull();
  });

  test("returns null for empty fence", () => {
    expect(parseRefinementOutput("```ts\n   \n```")).toBeNull();
  });
});
