import { describe, expect, test } from "bun:test";
import type { CodePlanStep, FileContentHash } from "./types.js";
import {
  computeHashes,
  DEFAULT_VALIDATION_CONFIG,
  validateStaleness,
  validateSteps,
} from "./validation.js";

const FILES = new Map<string, string>([
  ["/src/index.ts", 'export const foo = "bar";\nexport const baz = "qux";\n'],
  ["/src/utils.ts", "export function add(a: number, b: number): number {\n  return a + b;\n}\n"],
]);

describe("validateSteps", () => {
  test("empty plan returns error", () => {
    const issues = validateSteps([], FILES);
    expect(issues.length).toBe(1);
    expect(issues[0]?.kind).toBe("NO_MATCH");
  });

  test("valid edit step passes", () => {
    const steps: readonly CodePlanStep[] = [
      { kind: "edit", path: "/src/index.ts", edits: [{ oldText: '"bar"', newText: '"baz"' }] },
    ];
    const issues = validateSteps(steps, FILES);
    expect(issues.length).toBe(0);
  });

  test("oldText not found returns NO_MATCH", () => {
    const steps: readonly CodePlanStep[] = [
      { kind: "edit", path: "/src/index.ts", edits: [{ oldText: "nonexistent", newText: "new" }] },
    ];
    const issues = validateSteps(steps, FILES);
    expect(issues.length).toBe(1);
    expect(issues[0]?.kind).toBe("NO_MATCH");
  });

  test("ambiguous oldText returns AMBIGUOUS_MATCH", () => {
    const steps: readonly CodePlanStep[] = [
      {
        kind: "edit",
        path: "/src/index.ts",
        edits: [{ oldText: "export const", newText: "const" }],
      },
    ];
    const issues = validateSteps(steps, FILES);
    expect(issues.length).toBe(1);
    expect(issues[0]?.kind).toBe("AMBIGUOUS_MATCH");
  });

  test("overlapping edits returns OVERLAP", () => {
    const content = "ABCDEFGHIJ";
    const testFiles = new Map([["f.ts", content]]);
    const steps: readonly CodePlanStep[] = [
      {
        kind: "edit",
        path: "f.ts",
        edits: [
          { oldText: "ABCDEF", newText: "xxx" },
          { oldText: "DEFGHI", newText: "yyy" },
        ],
      },
    ];
    const issues = validateSteps(steps, testFiles);
    expect(issues.some((i) => i.kind === "OVERLAP")).toBe(true);
  });

  test("file not found for edit returns FILE_NOT_FOUND", () => {
    const steps: readonly CodePlanStep[] = [
      { kind: "edit", path: "/missing.ts", edits: [{ oldText: "x", newText: "y" }] },
    ];
    const issues = validateSteps(steps, FILES);
    expect(issues.length).toBe(1);
    expect(issues[0]?.kind).toBe("FILE_NOT_FOUND");
  });

  test("file exists for create returns FILE_EXISTS", () => {
    const steps: readonly CodePlanStep[] = [
      { kind: "create", path: "/src/index.ts", content: "new content" },
    ];
    const issues = validateSteps(steps, FILES);
    expect(issues.length).toBe(1);
    expect(issues[0]?.kind).toBe("FILE_EXISTS");
  });

  test("valid create step passes", () => {
    const steps: readonly CodePlanStep[] = [
      { kind: "create", path: "/src/new-file.ts", content: "export const x = 1;" },
    ];
    const issues = validateSteps(steps, FILES);
    expect(issues.length).toBe(0);
  });

  test("file too large returns FILE_TOO_LARGE", () => {
    const largeContent = "x".repeat(6 * 1024 * 1024);
    const testFiles = new Map([["large.ts", largeContent]]);
    const steps: readonly CodePlanStep[] = [
      { kind: "edit", path: "large.ts", edits: [{ oldText: "x", newText: "y" }] },
    ];
    const issues = validateSteps(steps, testFiles);
    expect(issues.some((i) => i.kind === "FILE_TOO_LARGE")).toBe(true);
  });

  test("large file triggers FILE_SIZE_WARNING", () => {
    const warnContent = "x".repeat(600 * 1024);
    const testFiles = new Map([["warn.ts", warnContent]]);
    const config = { ...DEFAULT_VALIDATION_CONFIG };
    const steps: readonly CodePlanStep[] = [
      { kind: "edit", path: "warn.ts", edits: [{ oldText: "x", newText: "y" }] },
    ];
    const issues = validateSteps(steps, testFiles, config);
    expect(issues.some((i) => i.kind === "FILE_SIZE_WARNING")).toBe(true);
  });
});

describe("computeHashes", () => {
  test("computes hashes for edit steps only", () => {
    const steps: readonly CodePlanStep[] = [
      { kind: "create", path: "/new.ts", content: "hello" },
      { kind: "edit", path: "/src/index.ts", edits: [{ oldText: '"bar"', newText: '"baz"' }] },
    ];
    const hashes = computeHashes(steps, FILES);
    expect(hashes.length).toBe(1);
    expect(hashes[0]?.path).toBe("/src/index.ts");
    expect(typeof hashes[0]?.hash).toBe("number");
  });

  test("deduplicates paths", () => {
    const steps: readonly CodePlanStep[] = [
      { kind: "edit", path: "/src/index.ts", edits: [{ oldText: '"bar"', newText: '"baz"' }] },
      { kind: "edit", path: "/src/index.ts", edits: [{ oldText: '"qux"', newText: '"quux"' }] },
    ];
    const hashes = computeHashes(steps, FILES);
    expect(hashes.length).toBe(1);
  });
});

describe("validateSteps — delete", () => {
  test("valid delete step for existing file passes", () => {
    const steps: readonly CodePlanStep[] = [{ kind: "delete", path: "/src/index.ts" }];
    const issues = validateSteps(steps, FILES);
    expect(issues.length).toBe(0);
  });

  test("delete step for missing file returns FILE_NOT_FOUND", () => {
    const steps: readonly CodePlanStep[] = [{ kind: "delete", path: "/missing.ts" }];
    const issues = validateSteps(steps, FILES);
    expect(issues.length).toBe(1);
    expect(issues[0]?.kind).toBe("FILE_NOT_FOUND");
  });
});

describe("computeHashes — delete", () => {
  test("computes hashes for delete steps", () => {
    const steps: readonly CodePlanStep[] = [{ kind: "delete", path: "/src/index.ts" }];
    const hashes = computeHashes(steps, FILES);
    expect(hashes.length).toBe(1);
    expect(hashes[0]?.path).toBe("/src/index.ts");
    expect(typeof hashes[0]?.hash).toBe("number");
  });
});

describe("validateSteps — rename", () => {
  test("valid rename step for existing source and nonexistent dest passes", () => {
    const steps: readonly CodePlanStep[] = [
      { kind: "rename", path: "/src/index.ts", to: "/src/main.ts" },
    ];
    const issues = validateSteps(steps, FILES);
    expect(issues.length).toBe(0);
  });

  test("rename step for missing source returns FILE_NOT_FOUND", () => {
    const steps: readonly CodePlanStep[] = [
      { kind: "rename", path: "/missing.ts", to: "/src/new.ts" },
    ];
    const issues = validateSteps(steps, FILES);
    expect(issues.length).toBe(1);
    expect(issues[0]?.kind).toBe("FILE_NOT_FOUND");
  });

  test("rename step to existing dest returns DEST_EXISTS", () => {
    const steps: readonly CodePlanStep[] = [
      { kind: "rename", path: "/src/index.ts", to: "/src/utils.ts" },
    ];
    const issues = validateSteps(steps, FILES);
    expect(issues.length).toBe(1);
    expect(issues[0]?.kind).toBe("DEST_EXISTS");
  });

  test("rename with missing source AND existing dest returns both errors", () => {
    const steps: readonly CodePlanStep[] = [
      { kind: "rename", path: "/missing.ts", to: "/src/utils.ts" },
    ];
    const issues = validateSteps(steps, FILES);
    expect(issues.length).toBe(2);
    expect(issues.some((i) => i.kind === "FILE_NOT_FOUND")).toBe(true);
    expect(issues.some((i) => i.kind === "DEST_EXISTS")).toBe(true);
  });
});

describe("computeHashes — rename", () => {
  test("computes hashes for rename step source paths", () => {
    const steps: readonly CodePlanStep[] = [
      { kind: "rename", path: "/src/index.ts", to: "/src/main.ts" },
    ];
    const hashes = computeHashes(steps, FILES);
    expect(hashes.length).toBe(1);
    expect(hashes[0]?.path).toBe("/src/index.ts");
    expect(typeof hashes[0]?.hash).toBe("number");
  });
});

describe("validateStaleness", () => {
  test("no issues when hashes match", () => {
    const hashes = computeHashes(
      [{ kind: "edit", path: "/src/index.ts", edits: [{ oldText: '"bar"', newText: '"baz"' }] }],
      FILES,
    );
    const issues = validateStaleness(hashes, FILES);
    expect(issues.length).toBe(0);
  });

  test("returns STALE when content changed", () => {
    const hashes = computeHashes(
      [{ kind: "edit", path: "/src/index.ts", edits: [{ oldText: '"bar"', newText: '"baz"' }] }],
      FILES,
    );
    const changedFiles = new Map([...FILES, ["/src/index.ts", "changed content"]]);
    const issues = validateStaleness(hashes, changedFiles);
    expect(issues.length).toBe(1);
    expect(issues[0]?.kind).toBe("STALE");
  });

  test("returns FILE_NOT_FOUND when file deleted", () => {
    const stored: readonly FileContentHash[] = [{ path: "/gone.ts", hash: 12345 }];
    const issues = validateStaleness(stored, new Map());
    expect(issues.length).toBe(1);
    expect(issues[0]?.kind).toBe("FILE_NOT_FOUND");
  });
});
