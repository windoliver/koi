import { describe, expect, test } from "bun:test";
import { extractCodeBlocks } from "./skill-scanner.js";

describe("extractCodeBlocks", () => {
  test("extracts typescript code blocks", () => {
    const md = "# Title\n\n```typescript\nconst x = 1;\n```\n";
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain("const x = 1;");
    expect(blocks[0]?.filename).toEndWith(".ts");
  });

  test("extracts js code blocks", () => {
    const md = "```js\nconst x = 1;\n```";
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.filename).toEndWith(".js");
  });

  test("extracts tsx code blocks", () => {
    const md = "```tsx\nconst el = <div />;\n```";
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.filename).toEndWith(".tsx");
  });

  test("extracts multiple code blocks", () => {
    const md = "```ts\nconst a = 1;\n```\n\nSome text\n\n```js\nconst b = 2;\n```";
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(2);
  });

  test("skips empty code blocks", () => {
    const md = "```ts\n\n```\n\n```ts\nconst x = 1;\n```";
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
  });

  test("skips non-JS/TS code blocks", () => {
    const md = `\`\`\`python
print("hello")
\`\`\`

\`\`\`ts
const x = 1;
\`\`\``;
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.filename).toEndWith(".ts");
  });

  test("returns empty for markdown with no code blocks", () => {
    const md = "# Title\n\nJust text.";
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(0);
  });

  test("calculates correct start line offset", () => {
    const md = "Line 1\nLine 2\nLine 3\n```ts\nconst x = 1;\n```";
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.startLine).toBe(4);
  });

  test("defaults to .ts extension for untagged code blocks", () => {
    const md = "```\nconst x = 1;\n```";
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.filename).toEndWith(".ts");
  });
});
