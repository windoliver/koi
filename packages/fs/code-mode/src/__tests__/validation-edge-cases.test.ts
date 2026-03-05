/**
 * Edge case tests for validation pipeline.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createPlanStore } from "../plan-store.js";
import { createMockBackend } from "../test-helpers.js";
import { createPlanApplyTool } from "../tools/plan-apply.js";
import { createPlanCreateTool } from "../tools/plan-create.js";
import type { PlanPreview, ValidationIssue } from "../types.js";

describe("validation edge cases", () => {
  test("multi-file plan with mixed creates and edits", async () => {
    const backend = createMockBackend({
      "/src/a.ts": "const a = 1;",
      "/src/b.ts": "const b = 2;",
    });
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({
      steps: [
        {
          kind: "edit",
          path: "/src/a.ts",
          edits: [{ oldText: "const a = 1;", newText: "const a = 10;" }],
        },
        {
          kind: "edit",
          path: "/src/b.ts",
          edits: [{ oldText: "const b = 2;", newText: "const b = 20;" }],
        },
        { kind: "create", path: "/src/c.ts", content: "export const c = 30;" },
      ],
    })) as PlanPreview;

    expect(result.planId).toBeDefined();
    expect(result.files.length).toBe(3);
  });

  test("multiple edits in same file (non-overlapping)", async () => {
    const content = "line1\nline2\nline3\nline4\nline5";
    const backend = createMockBackend({ "/f.ts": content });
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({
      steps: [
        {
          kind: "edit",
          path: "/f.ts",
          edits: [
            { oldText: "line1", newText: "LINE1" },
            { oldText: "line5", newText: "LINE5" },
          ],
        },
      ],
    })) as PlanPreview;

    expect(result.planId).toBeDefined();
  });

  test("edit step with empty oldText matches everywhere (ambiguous)", async () => {
    const backend = createMockBackend({ "/f.ts": "abc" });
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({
      steps: [{ kind: "edit", path: "/f.ts", edits: [{ oldText: "", newText: "x" }] }],
    })) as { issues: readonly ValidationIssue[] };

    // Empty string matches at position 0, and again at position 1 — ambiguous
    expect(result.issues.some((i) => i.kind === "AMBIGUOUS_MATCH")).toBe(true);
  });

  test("staleness detected when file changes between create and apply", async () => {
    // Start with known content
    const files: Record<string, string> = {
      "/f.ts": "original content",
    };
    const backend = createMockBackend(files);
    const store = createPlanStore();

    const createTool = createPlanCreateTool(
      backend,
      store,
      "code_plan",
      DEFAULT_UNSANDBOXED_POLICY,
    );
    const applyTool = createPlanApplyTool(backend, store, "code_plan", DEFAULT_UNSANDBOXED_POLICY);

    // Create plan
    const preview = (await createTool.execute({
      steps: [
        { kind: "edit", path: "/f.ts", edits: [{ oldText: "original", newText: "updated" }] },
      ],
    })) as PlanPreview;

    expect(preview.planId).toBeDefined();

    // Simulate file change by writing directly to backend
    backend.write("/f.ts", "someone else changed this");

    // Apply should fail with STALE_REF
    const result = (await applyTool.execute({})) as { error: string; code: string };
    expect(result.code).toBe("STALE_REF");
    expect(store.get()?.state).toBe("failed");
  });

  test("create step for file that already exists fails validation", async () => {
    const backend = createMockBackend({ "/existing.ts": "hello" });
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({
      steps: [{ kind: "create", path: "/existing.ts", content: "new content" }],
    })) as { issues: readonly ValidationIssue[] };

    expect(result.issues.some((i) => i.kind === "FILE_EXISTS")).toBe(true);
  });

  test("edit step for missing file fails validation", async () => {
    const backend = createMockBackend();
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({
      steps: [{ kind: "edit", path: "/missing.ts", edits: [{ oldText: "x", newText: "y" }] }],
    })) as { issues: readonly ValidationIssue[] };

    expect(result.issues.some((i) => i.kind === "FILE_NOT_FOUND")).toBe(true);
  });

  test("overlapping edits in same file fail validation", async () => {
    const content = "ABCDEFGHIJKLMNOP";
    const backend = createMockBackend({ "/f.ts": content });
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", DEFAULT_UNSANDBOXED_POLICY);

    const result = (await tool.execute({
      steps: [
        {
          kind: "edit",
          path: "/f.ts",
          edits: [
            { oldText: "ABCDEFGH", newText: "xxx" },
            { oldText: "EFGHIJKL", newText: "yyy" },
          ],
        },
      ],
    })) as { issues: readonly ValidationIssue[] };

    expect(result.issues.some((i) => i.kind === "OVERLAP")).toBe(true);
  });
});
