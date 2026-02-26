import { describe, expect, test } from "bun:test";
import { generatePreview } from "./preview.js";
import type { CodePlan } from "./types.js";

function makePlan(overrides: Partial<CodePlan> = {}): CodePlan {
  return {
    id: "plan-001",
    steps: [],
    state: "pending",
    createdAt: Date.now(),
    hashes: [],
    warnings: [],
    ...overrides,
  };
}

describe("generatePreview", () => {
  test("generates summary for mixed steps", () => {
    const plan = makePlan({
      steps: [
        { kind: "create", path: "/src/new.ts", content: "export const x = 1;" },
        { kind: "edit", path: "/src/old.ts", edits: [{ oldText: "old", newText: "new" }] },
        { kind: "edit", path: "/src/other.ts", edits: [{ oldText: "a", newText: "b" }] },
      ],
    });
    const preview = generatePreview(plan);
    expect(preview.summary).toBe("3 files: 1 create, 2 edits");
    expect(preview.planId).toBe("plan-001");
    expect(preview.files.length).toBe(3);
  });

  test("create step shows + prefix", () => {
    const plan = makePlan({
      steps: [{ kind: "create", path: "/new.ts", content: "line1\nline2" }],
    });
    const preview = generatePreview(plan);
    expect(preview.files[0]?.lines[0]).toBe("+++ /new.ts");
    expect(preview.files[0]?.lines[1]).toBe("+ line1");
    expect(preview.files[0]?.lines[2]).toBe("+ line2");
    expect(preview.files[0]?.kind).toBe("create");
  });

  test("edit step shows - and + prefix", () => {
    const plan = makePlan({
      steps: [{ kind: "edit", path: "/f.ts", edits: [{ oldText: "old", newText: "new" }] }],
    });
    const preview = generatePreview(plan);
    expect(preview.files[0]?.lines[0]).toBe("~~~ /f.ts");
    expect(preview.files[0]?.lines[1]).toBe("- old");
    expect(preview.files[0]?.lines[2]).toBe("+ new");
    expect(preview.files[0]?.kind).toBe("edit");
  });

  test("description appears in header", () => {
    const plan = makePlan({
      steps: [{ kind: "create", path: "/f.ts", content: "x", description: "add config" }],
    });
    const preview = generatePreview(plan);
    expect(preview.files[0]?.lines[0]).toBe("+++ /f.ts (add config)");
  });

  test("truncates long file content", () => {
    const longContent = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const plan = makePlan({
      steps: [{ kind: "create", path: "/f.ts", content: longContent }],
    });
    const preview = generatePreview(plan);
    expect(preview.files[0]?.truncated).toBe(true);
    // 50 lines per file max (1 header + 49 content lines)
    expect(preview.files[0]?.lines.length).toBeLessThanOrEqual(51);
  });

  test("includes warnings from plan", () => {
    const plan = makePlan({ warnings: ["large file detected"] });
    const preview = generatePreview(plan);
    expect(preview.warnings).toEqual(["large file detected"]);
  });

  test("single create summary uses singular", () => {
    const plan = makePlan({
      steps: [{ kind: "create", path: "/f.ts", content: "x" }],
    });
    const preview = generatePreview(plan);
    expect(preview.summary).toBe("1 file: 1 create");
  });

  test("delete step shows --- header and deletion message", () => {
    const plan = makePlan({
      steps: [{ kind: "delete", path: "/old.ts" }],
    });
    const preview = generatePreview(plan);
    expect(preview.files[0]?.lines[0]).toBe("--- /old.ts");
    expect(preview.files[0]?.lines[1]).toBe("(file will be deleted)");
    expect(preview.files[0]?.kind).toBe("delete");
    expect(preview.files[0]?.truncated).toBe(false);
  });

  test("delete step with description shows description in header", () => {
    const plan = makePlan({
      steps: [{ kind: "delete", path: "/old.ts", description: "remove legacy" }],
    });
    const preview = generatePreview(plan);
    expect(preview.files[0]?.lines[0]).toBe("--- /old.ts (remove legacy)");
  });

  test("summary includes delete count", () => {
    const plan = makePlan({
      steps: [
        { kind: "create", path: "/new.ts", content: "x" },
        { kind: "delete", path: "/old.ts" },
        { kind: "delete", path: "/old2.ts" },
      ],
    });
    const preview = generatePreview(plan);
    expect(preview.summary).toBe("3 files: 1 create, 2 deletes");
  });

  test("edit preview with context shows surrounding lines", () => {
    const fileContents = new Map([
      [
        "/src/index.ts",
        [
          'import { foo } from "./bar.js";',
          "",
          'export const version = "1.0.0";',
          "",
          "export function main() {",
          "  return version;",
          "}",
        ].join("\n"),
      ],
    ]);
    const plan = makePlan({
      steps: [
        {
          kind: "edit",
          path: "/src/index.ts",
          edits: [
            {
              oldText: 'export const version = "1.0.0";',
              newText: 'export const version = "2.0.0";',
            },
          ],
        },
      ],
      fileContents,
    });
    const preview = generatePreview(plan);
    const lines = preview.files[0]?.lines ?? [];

    // Header
    expect(lines[0]).toBe("~~~ /src/index.ts");

    // Context before (2 lines: import + empty — line 0 and 1, match is at line 2)
    expect(lines[1]).toBe('  import { foo } from "./bar.js";');
    expect(lines[2]).toBe("  ");

    // Diff
    expect(lines[3]).toBe('- export const version = "1.0.0";');
    expect(lines[4]).toBe('+ export const version = "2.0.0";');

    // Context after (3 lines: empty, export function, return)
    expect(lines[5]).toBe("  ");
    expect(lines[6]).toBe("  export function main() {");
    expect(lines[7]).toBe("    return version;");
  });

  test("context lines have 2-space prefix (no +/-)", () => {
    const fileContents = new Map([["/f.ts", "line1\nline2\nline3\nline4\nline5"]]);
    const plan = makePlan({
      steps: [
        {
          kind: "edit",
          path: "/f.ts",
          edits: [{ oldText: "line3", newText: "LINE3" }],
        },
      ],
      fileContents,
    });
    const preview = generatePreview(plan);
    const lines = preview.files[0]?.lines ?? [];

    // Context lines should start with "  " (2-space indent)
    const contextLines = lines.filter((l) => l.startsWith("  "));
    expect(contextLines.length).toBeGreaterThan(0);
    for (const cl of contextLines) {
      expect(cl.startsWith("  ")).toBe(true);
      expect(cl.startsWith("  -")).toBe(false);
      expect(cl.startsWith("  +")).toBe(false);
    }
  });

  test("short files show all available context (less than 3 lines)", () => {
    const fileContents = new Map([["/f.ts", "only\ntarget\nend"]]);
    const plan = makePlan({
      steps: [
        {
          kind: "edit",
          path: "/f.ts",
          edits: [{ oldText: "target", newText: "REPLACED" }],
        },
      ],
      fileContents,
    });
    const preview = generatePreview(plan);
    const lines = preview.files[0]?.lines ?? [];

    // Header + 1 context before + diff + 1 context after
    expect(lines[0]).toBe("~~~ /f.ts");
    expect(lines[1]).toBe("  only");
    expect(lines[2]).toBe("- target");
    expect(lines[3]).toBe("+ REPLACED");
    expect(lines[4]).toBe("  end");
  });

  test("rename step shows >>> header with source and destination", () => {
    const plan = makePlan({
      steps: [{ kind: "rename", path: "/old.ts", to: "/new.ts" }],
    });
    const preview = generatePreview(plan);
    expect(preview.files[0]?.lines[0]).toBe(">>> /old.ts -> /new.ts");
    expect(preview.files[0]?.kind).toBe("rename");
    expect(preview.files[0]?.truncated).toBe(false);
    expect(preview.files[0]?.lines.length).toBe(1);
  });

  test("rename step with description shows description in header", () => {
    const plan = makePlan({
      steps: [
        { kind: "rename", path: "/old.ts", to: "/new.ts", description: "move to new location" },
      ],
    });
    const preview = generatePreview(plan);
    expect(preview.files[0]?.lines[0]).toBe(">>> /old.ts -> /new.ts (move to new location)");
  });

  test("summary includes rename count", () => {
    const plan = makePlan({
      steps: [
        { kind: "create", path: "/new.ts", content: "x" },
        { kind: "rename", path: "/old.ts", to: "/moved.ts" },
        { kind: "rename", path: "/old2.ts", to: "/moved2.ts" },
      ],
    });
    const preview = generatePreview(plan);
    expect(preview.summary).toBe("3 files: 1 create, 2 renames");
  });

  test("edit preview without fileContents shows no context lines", () => {
    const plan = makePlan({
      steps: [{ kind: "edit", path: "/f.ts", edits: [{ oldText: "old", newText: "new" }] }],
    });
    const preview = generatePreview(plan);
    const lines = preview.files[0]?.lines ?? [];

    // Only header + diff lines, no context
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe("~~~ /f.ts");
    expect(lines[1]).toBe("- old");
    expect(lines[2]).toBe("+ new");
  });
});
