import { describe, expect, test } from "bun:test";
import { extractImportSpecifiers, isL0Violation, isL2Violation } from "./check-layers.js";

// ---------------------------------------------------------------------------
// isL0Violation — L0 source import predicate
// ---------------------------------------------------------------------------

describe("isL0Violation", () => {
  test("relative path ./foo.js is not a violation", () => {
    expect(isL0Violation("./foo.js")).toBe(false);
  });

  test("relative path ../types.js is not a violation", () => {
    expect(isL0Violation("../types.js")).toBe(false);
  });

  test("deep relative path ../../utils.js is not a violation", () => {
    expect(isL0Violation("../../utils.js")).toBe(false);
  });

  test("external package @langchain/langgraph is a violation", () => {
    expect(isL0Violation("@langchain/langgraph")).toBe(true);
  });

  test("zod is a violation", () => {
    expect(isL0Violation("zod")).toBe(true);
  });

  test("node:fs is a violation", () => {
    expect(isL0Violation("node:fs")).toBe(true);
  });

  test("@koi/engine import in L0 source is a violation", () => {
    expect(isL0Violation("@koi/engine")).toBe(true);
  });

  test("@koi/core import in L0 source is a violation (would be circular)", () => {
    expect(isL0Violation("@koi/core")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isL2Violation — L2 source import predicate
// ---------------------------------------------------------------------------

describe("isL2Violation", () => {
  test("@koi/engine is a violation", () => {
    expect(isL2Violation("@koi/engine")).toBe(true);
  });

  test("@koi/engine/subpath is a violation", () => {
    expect(isL2Violation("@koi/engine/runtime")).toBe(true);
  });

  test("@koi/core is not a violation", () => {
    expect(isL2Violation("@koi/core")).toBe(false);
  });

  test("@koi/errors is not a violation", () => {
    expect(isL2Violation("@koi/errors")).toBe(false);
  });

  test("relative import ./foo.js is not a violation", () => {
    expect(isL2Violation("./foo.js")).toBe(false);
  });

  test("external package zod is not a violation (only L1 imports are forbidden)", () => {
    expect(isL2Violation("zod")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractImportSpecifiers — Bun.Transpiler AST-based scanner
// ---------------------------------------------------------------------------

describe("extractImportSpecifiers", () => {
  test("extracts static import specifier", () => {
    const source = `import { foo } from "./foo.js";`;
    expect(extractImportSpecifiers(source)).toContain("./foo.js");
  });

  test("extracts external package specifier", () => {
    const source = `import { Graph } from "@langchain/langgraph";`;
    expect(extractImportSpecifiers(source)).toContain("@langchain/langgraph");
  });

  test("extracts type-only import specifier", () => {
    const source = `import type { X } from "./x.js";`;
    expect(extractImportSpecifiers(source)).toContain("./x.js");
  });

  test("extracts dynamic import specifier", () => {
    const source = `const m = await import("./module.js");`;
    expect(extractImportSpecifiers(source)).toContain("./module.js");
  });

  test("does not extract import from full-line comment", () => {
    const source = `// import { x } from "@koi/engine";`;
    expect(extractImportSpecifiers(source)).not.toContain("@koi/engine");
  });

  test("does not extract import from block comment", () => {
    const source = `/* import { x } from "@koi/engine"; */`;
    expect(extractImportSpecifiers(source)).not.toContain("@koi/engine");
  });

  test("returns empty array for source with no imports", () => {
    const source = `export const x = 42;`;
    expect(extractImportSpecifiers(source)).toHaveLength(0);
  });

  test("extracts multiple imports from same file", () => {
    const source = [
      `import { a } from "./a.js";`,
      `import { b } from "@koi/core";`,
      `import type { C } from "./c.js";`,
    ].join("\n");
    const specs = extractImportSpecifiers(source);
    expect(specs).toContain("./a.js");
    expect(specs).toContain("@koi/core");
    expect(specs).toContain("./c.js");
  });

  // Regression: L2 source importing @koi/engine must be caught
  test("extracts @koi/engine specifier (L2 violation regression)", () => {
    const source = `import { createEngine } from "@koi/engine";`;
    expect(extractImportSpecifiers(source)).toContain("@koi/engine");
  });
});
