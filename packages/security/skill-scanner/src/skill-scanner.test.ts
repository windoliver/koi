import { describe, expect, test } from "bun:test";
import { extractCodeBlocks } from "./skill-scanner.js";

describe("extractCodeBlocks — fence length enforcement (CommonMark §6.1)", () => {
  test("4-backtick block is not closed by inner 3-backtick line", () => {
    const md = ["````ts", 'const safe = "harmless";', "```", 'eval("smuggled");', "````"].join(
      "\n",
    );
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain('eval("smuggled")');
    expect(blocks[0]?.code).toContain("```");
  });

  test("4-backtick block closed by 5-backtick fence (length >= opener)", () => {
    const md = ["````ts", 'const x = "inner";', "```", 'eval("also inner");', "`````"].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain('eval("also inner")');
  });

  test("4-tilde block is not closed by inner 3-tilde line", () => {
    const md = ["~~~~ts", 'const safe = "ok";', "~~~", 'eval("hidden");', "~~~~"].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain('eval("hidden")');
    expect(blocks[0]?.code).toContain("~~~");
  });

  test("3-backtick block still closed by 3-backtick fence", () => {
    const md = ["```ts", "const x = 1;", "```"].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain("const x = 1;");
  });

  test("3-backtick block closed by longer backtick fence", () => {
    const md = ["```ts", "const x = 1;", "``````"].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain("const x = 1;");
  });

  test("tilde fence does not close backtick block", () => {
    const md = ["```ts", "const a = 1;", "~~~", 'eval("still inside");', "```"].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain('eval("still inside")');
  });

  test("backtick fence does not close tilde block", () => {
    const md = ["~~~ts", "const a = 1;", "```", 'eval("still inside");', "~~~"].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain('eval("still inside")');
  });

  test("5-tilde block not closed by 4-tilde line", () => {
    const md = ["~~~~~ts", 'eval("deep");', "~~~~", 'eval("deeper");', "~~~~~"].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain('eval("deeper")');
  });

  test("unclosed fence at EOF emits block (CommonMark §4.5)", () => {
    const md = ["````ts", 'eval("never closed");', "```"].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain('eval("never closed")');
    expect(blocks[0]?.code).toContain("```");
  });

  test("unclosed 3-backtick fence at EOF emits block", () => {
    const md = ["```ts", 'eval("no closer");'].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain('eval("no closer")');
  });

  test("mixed-character closer does not close backtick block", () => {
    const md = ["````ts", "const safe = 1;", "`~~~", 'eval("smuggled");', "````"].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain('eval("smuggled")');
  });

  test("mixed-character closer does not close tilde block", () => {
    const md = ["~~~~ts", "const safe = 1;", "~```", 'eval("smuggled");', "~~~~"].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain('eval("smuggled")');
  });

  test("indented closing fence respects length enforcement", () => {
    const md = ["````ts", 'eval("indented close");', "   ````"].join("\n");
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toContain('eval("indented close")');
  });
});
