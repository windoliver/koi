import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractImportSpecifiers,
  isClassDeclaration,
  isFunctionBody,
  isL0ClassViolation,
  isL0uViolation,
  isL0Violation,
  isL2Violation,
  isTestFile,
  L0_RUNTIME_ALLOWLIST,
  scanFilesForViolations,
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
// isTestFile — test file classifier
// ---------------------------------------------------------------------------

describe("isTestFile", () => {
  test("__tests__/ directory path is a test file", () => {
    expect(isTestFile("/packages/foo/src/__tests__/setup.ts")).toBe(true);
  });

  test(".test.ts suffix is a test file", () => {
    expect(isTestFile("/packages/foo/src/foo.test.ts")).toBe(true);
  });

  test(".e2e.test.ts suffix is a test file", () => {
    expect(isTestFile("/packages/foo/src/foo.e2e.test.ts")).toBe(true);
  });

  test(".spec.ts suffix is a test file", () => {
    expect(isTestFile("/packages/foo/src/foo.spec.ts")).toBe(true);
  });

  test("plain .ts source file is not a test file", () => {
    expect(isTestFile("/packages/foo/src/foo.ts")).toBe(false);
  });

  test("file with 'test' in the name but wrong suffix is not a test file", () => {
    expect(isTestFile("/packages/foo/src/my-test.ts")).toBe(false);
  });

  test("file with 'test' as prefix is not a test file", () => {
    expect(isTestFile("/packages/foo/src/testable.ts")).toBe(false);
  });

  test(".spec.js is not a test file (wrong extension)", () => {
    expect(isTestFile("/packages/foo/src/setup.spec.js")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isL0uViolation — L0u source import predicate
// ---------------------------------------------------------------------------

describe("isL0uViolation", () => {
  test("@koi/engine is a violation (L1 import forbidden in L0u)", () => {
    expect(isL0uViolation("@koi/engine")).toBe(true);
  });

  test("@koi/engine/subpath is a violation", () => {
    expect(isL0uViolation("@koi/engine/runtime")).toBe(true);
  });

  test("@koi/gateway is a violation (L2 import forbidden in L0u)", () => {
    expect(isL0uViolation("@koi/gateway")).toBe(true);
  });

  test("@koi/core is not a violation (L0 import allowed in L0u)", () => {
    expect(isL0uViolation("@koi/core")).toBe(false);
  });

  test("@koi/errors is not a violation (peer L0u import allowed)", () => {
    expect(isL0uViolation("@koi/errors")).toBe(false);
  });

  test("relative import ./utils.js is not a violation", () => {
    expect(isL0uViolation("./utils.js")).toBe(false);
  });

  test("external package zod is not a violation", () => {
    expect(isL0uViolation("zod")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isL0ClassViolation — L0 class declaration check
// ---------------------------------------------------------------------------

describe("isL0ClassViolation", () => {
  test("exported class declaration is a violation", () => {
    expect(isL0ClassViolation("export class Foo {")).toBe(true);
  });

  test("exported abstract class is a violation", () => {
    expect(isL0ClassViolation("export abstract class Foo extends Bar {")).toBe(true);
  });

  test("unexported class declaration is a violation", () => {
    expect(isL0ClassViolation("class InternalFoo {")).toBe(true);
  });

  test("interface declaration is not a violation", () => {
    expect(isL0ClassViolation("export interface Foo {")).toBe(false);
  });

  test("type alias is not a violation", () => {
    expect(isL0ClassViolation("export type Bar = string;")).toBe(false);
  });

  test("identifier containing 'class' substring is not a violation", () => {
    expect(isL0ClassViolation("export const classifyItems = () => {};")).toBe(false);
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

  // Regression: multiline type imports must not be missed
  test("extracts specifier from multiline type import", () => {
    const source = `import type {\n  Foo,\n  Bar\n} from "@koi/engine";`;
    expect(extractImportSpecifiers(source)).toContain("@koi/engine");
  });
});

// ---------------------------------------------------------------------------
// scanFilesForViolations — integration tests using temp directories
// ---------------------------------------------------------------------------

describe("scanFilesForViolations — integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "koi-check-layers-"));
    await mkdir(join(tmpDir, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("detects violation in non-test source file", async () => {
    await writeFile(join(tmpDir, "src", "foo.ts"), 'import { Engine } from "@koi/engine";\n');
    const violations = await scanFilesForViolations(
      join(tmpDir, "src"),
      "@koi/test-pkg",
      isL2Violation,
      (_specifier, relPath) => `forbidden import at ${relPath}`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("forbidden import");
  });

  test("skips .test.ts files — violations inside are ignored", async () => {
    await writeFile(join(tmpDir, "src", "foo.test.ts"), 'import { Engine } from "@koi/engine";\n');
    const violations = await scanFilesForViolations(
      join(tmpDir, "src"),
      "@koi/test-pkg",
      isL2Violation,
      (_specifier, relPath) => `forbidden import at ${relPath}`,
    );
    expect(violations).toHaveLength(0);
  });

  test("returns empty array for clean source file", async () => {
    await writeFile(join(tmpDir, "src", "bar.ts"), "export const x = 42;\n");
    const violations = await scanFilesForViolations(
      join(tmpDir, "src"),
      "@koi/test-pkg",
      isL2Violation,
      (_specifier, relPath) => `forbidden import at ${relPath}`,
    );
    expect(violations).toHaveLength(0);
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
