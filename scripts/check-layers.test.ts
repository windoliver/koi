import { describe, expect, test } from "bun:test";
import {
  extractImportSpecifiers,
  isClassDeclaration,
  isFunctionBody,
  isL0Violation,
  isL2Violation,
  L0_RUNTIME_ALLOWLIST,
} from "./check-layers.js";

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

// ---------------------------------------------------------------------------
// isClassDeclaration — L0 class detection
// ---------------------------------------------------------------------------

describe("isClassDeclaration", () => {
  test("detects export class", () => {
    expect(isClassDeclaration("export class Foo {")).toBe(true);
  });

  test("detects non-exported class", () => {
    expect(isClassDeclaration("class Bar {")).toBe(true);
  });

  test("ignores interface declarations", () => {
    expect(isClassDeclaration("export interface Baz {")).toBe(false);
  });

  test("ignores type alias", () => {
    expect(isClassDeclaration("export type Qux = string;")).toBe(false);
  });

  test("detects abstract class", () => {
    expect(isClassDeclaration("abstract class Baz {")).toBe(true);
  });

  test("detects export abstract class", () => {
    expect(isClassDeclaration("export abstract class Qux {")).toBe(true);
  });

  test("ignores class reference in string", () => {
    expect(isClassDeclaration('const x = "class Foo";')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFunctionBody — L0 exported function detection
// ---------------------------------------------------------------------------

describe("isFunctionBody", () => {
  test("detects export function", () => {
    expect(isFunctionBody("export function foo(): void {")).toBe(true);
  });

  test("detects export async function", () => {
    expect(isFunctionBody("export async function bar(): Promise<void> {")).toBe(true);
  });

  test("detects exported arrow function", () => {
    expect(isFunctionBody("export const baz = (x: number): number => x;")).toBe(true);
  });

  test("detects exported async arrow function", () => {
    expect(isFunctionBody("export const qux = async (x: string): Promise<string> => x;")).toBe(
      true,
    );
  });

  test("ignores type declarations", () => {
    expect(isFunctionBody("export type Fn = () => void;")).toBe(false);
  });

  test("ignores interface method signatures", () => {
    expect(isFunctionBody("  send(msg: Message): void;")).toBe(false);
  });

  test("detects non-exported function", () => {
    expect(isFunctionBody("function helper(): void {")).toBe(true);
  });

  test("detects non-exported async function", () => {
    expect(isFunctionBody("async function compute(): Promise<void> {")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L0_RUNTIME_ALLOWLIST — sanity checks
// ---------------------------------------------------------------------------

describe("L0_RUNTIME_ALLOWLIST", () => {
  test("contains known allowlisted files", () => {
    expect(L0_RUNTIME_ALLOWLIST.has("ecs.ts")).toBe(true);
    expect(L0_RUNTIME_ALLOWLIST.has("error-factories.ts")).toBe(true);
    expect(L0_RUNTIME_ALLOWLIST.has("validation-utils.ts")).toBe(true);
  });

  test("does not contain type-only files", () => {
    expect(L0_RUNTIME_ALLOWLIST.has("middleware.ts")).toBe(false);
    expect(L0_RUNTIME_ALLOWLIST.has("channel.ts")).toBe(false);
    expect(L0_RUNTIME_ALLOWLIST.has("message.ts")).toBe(false);
  });
});
