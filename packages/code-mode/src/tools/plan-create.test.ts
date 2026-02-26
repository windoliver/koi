import { describe, expect, test } from "bun:test";
import { createPlanStore } from "../plan-store.js";
import { createMockBackend } from "../test-helpers.js";
import type { PlanPreview, ValidationIssue } from "../types.js";
import { createPlanCreateTool } from "./plan-create.js";

describe("createPlanCreateTool", () => {
  test("creates plan for valid create step", async () => {
    const backend = createMockBackend();
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({
      steps: [{ kind: "create", path: "/new.ts", content: "export const x = 1;" }],
    })) as PlanPreview;

    expect(result.planId).toBeDefined();
    expect(result.summary).toContain("1 create");
    expect(store.get()).toBeDefined();
    expect(store.get()?.state).toBe("pending");
  });

  test("creates plan for valid edit step", async () => {
    const backend = createMockBackend({
      "/src/index.ts": 'export const foo = "bar";',
    });
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({
      steps: [
        {
          kind: "edit",
          path: "/src/index.ts",
          edits: [{ oldText: '"bar"', newText: '"baz"' }],
        },
      ],
    })) as PlanPreview;

    expect(result.planId).toBeDefined();
    expect(result.summary).toContain("1 edit");
  });

  test("returns validation error for empty steps", async () => {
    const backend = createMockBackend();
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({ steps: [] })) as { error: string; code: string };
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for missing steps array", async () => {
    const backend = createMockBackend();
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({})) as { error: string; code: string };
    expect(result.code).toBe("VALIDATION");
  });

  test("returns NO_MATCH for oldText not found", async () => {
    const backend = createMockBackend({
      "/f.ts": "hello world",
    });
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({
      steps: [{ kind: "edit", path: "/f.ts", edits: [{ oldText: "missing", newText: "x" }] }],
    })) as { error: string; issues: readonly ValidationIssue[] };

    expect(result.error).toBe("Validation failed");
    expect(result.issues.some((i) => i.kind === "NO_MATCH")).toBe(true);
    expect(store.get()).toBeUndefined();
  });

  test("returns AMBIGUOUS_MATCH for multiple matches", async () => {
    const backend = createMockBackend({
      "/f.ts": "aaa\naaa",
    });
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({
      steps: [{ kind: "edit", path: "/f.ts", edits: [{ oldText: "aaa", newText: "bbb" }] }],
    })) as { issues: readonly ValidationIssue[] };

    expect(result.issues.some((i) => i.kind === "AMBIGUOUS_MATCH")).toBe(true);
  });

  test("new plan discards old plan", async () => {
    const backend = createMockBackend();
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", "verified");

    await tool.execute({ steps: [{ kind: "create", path: "/a.ts", content: "a" }] });
    const firstId = store.get()?.id;

    await tool.execute({ steps: [{ kind: "create", path: "/b.ts", content: "b" }] });
    const secondId = store.get()?.id;

    expect(firstId).not.toBe(secondId);
  });

  test("creates plan for valid delete step", async () => {
    const backend = createMockBackend({ "/old.ts": "to be deleted" });
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({
      steps: [{ kind: "delete", path: "/old.ts" }],
    })) as PlanPreview;

    expect(result.planId).toBeDefined();
    expect(result.summary).toContain("1 delete");
    expect(store.get()).toBeDefined();
  });

  test("returns VALIDATION error for delete with no backend.delete", async () => {
    const backend = createMockBackend({ "/old.ts": "content" });
    // Create a backend without delete support by destructuring out delete
    const { delete: _del, ...rest } = backend;
    const backendNoDelete = rest as typeof backend;
    const store = createPlanStore();
    const tool = createPlanCreateTool(backendNoDelete, store, "code_plan", "verified");

    const result = (await tool.execute({
      steps: [{ kind: "delete", path: "/old.ts" }],
    })) as { error: string; code: string };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("delet");
  });

  test("returns error for invalid step kind", async () => {
    const backend = createMockBackend();
    const store = createPlanStore();
    const tool = createPlanCreateTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({
      steps: [{ kind: "unknown", path: "/f.ts" }],
    })) as { error: string; code: string };

    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("kind");
  });
});
