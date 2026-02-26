import { describe, expect, test } from "bun:test";
import { createPlanStore } from "../plan-store.js";
import { createFailingBackend, createMockBackend } from "../test-helpers.js";
import type { ApplyResult, CodePlan } from "../types.js";
import { createPlanApplyTool } from "./plan-apply.js";

function makePlan(overrides: Partial<CodePlan> = {}): CodePlan {
  return {
    id: "plan-001",
    steps: [{ kind: "create", path: "/new.ts", content: "export const x = 1;" }],
    state: "pending",
    createdAt: Date.now(),
    hashes: [],
    warnings: [],
    ...overrides,
  };
}

describe("createPlanApplyTool", () => {
  test("returns NOT_FOUND when no plan exists", async () => {
    const backend = createMockBackend();
    const store = createPlanStore();
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({})) as { error: string; code: string };
    expect(result.code).toBe("NOT_FOUND");
  });

  test("applies pending plan successfully", async () => {
    const backend = createMockBackend();
    const store = createPlanStore();
    store.set(makePlan());
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({})) as ApplyResult;
    expect(result.success).toBe(true);
    expect(result.planId).toBe("plan-001");
    expect(result.steps.length).toBe(1);
    expect(result.steps[0]?.success).toBe(true);
    expect(store.get()?.state).toBe("applied");
  });

  test("returns CONFLICT for already applied plan", async () => {
    const backend = createMockBackend();
    const store = createPlanStore();
    store.set(makePlan({ state: "applied" }));
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({})) as { error: string; code: string };
    expect(result.code).toBe("CONFLICT");
  });

  test("returns CONFLICT for failed plan", async () => {
    const backend = createMockBackend();
    const store = createPlanStore();
    store.set(makePlan({ state: "failed" }));
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({})) as { error: string; code: string };
    expect(result.code).toBe("CONFLICT");
  });

  test("returns CONFLICT for plan ID mismatch", async () => {
    const backend = createMockBackend();
    const store = createPlanStore();
    store.set(makePlan({ id: "abc" }));
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({ planId: "wrong-id" })) as { error: string; code: string };
    expect(result.code).toBe("CONFLICT");
  });

  test("marks plan failed on backend write error", async () => {
    const backend = createFailingBackend();
    const store = createPlanStore();
    store.set(makePlan());
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({})) as ApplyResult;
    expect(result.success).toBe(false);
    expect(store.get()?.state).toBe("failed");
  });

  test("accepts matching planId confirmation", async () => {
    const backend = createMockBackend();
    const store = createPlanStore();
    store.set(makePlan({ id: "my-plan" }));
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({ planId: "my-plan" })) as ApplyResult;
    expect(result.success).toBe(true);
  });

  test("applies delete step successfully", async () => {
    const backend = createMockBackend({ "/old.ts": "to be deleted" });
    const store = createPlanStore();
    store.set(
      makePlan({
        steps: [{ kind: "delete", path: "/old.ts" }],
      }),
    );
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({})) as ApplyResult;
    expect(result.success).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.rollbackErrors).toEqual([]);

    // Verify file was deleted
    const readResult = await backend.read("/old.ts");
    expect(readResult.ok).toBe(false);
  });

  test("delete step fails if backend errors", async () => {
    const backend = createFailingBackend();
    const store = createPlanStore();
    store.set(
      makePlan({
        steps: [{ kind: "delete", path: "/old.ts" }],
      }),
    );
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({})) as ApplyResult;
    expect(result.success).toBe(false);
    expect(store.get()?.state).toBe("failed");
  });

  test("rolls back completed steps when later step fails", async () => {
    // Step 2 (edit) will fail because the file doesn't exist in the backend
    const backend = createMockBackend();
    const store = createPlanStore();
    store.set(
      makePlan({
        steps: [
          { kind: "create", path: "/new.ts", content: "new file" },
          {
            kind: "edit",
            path: "/nonexistent.ts",
            edits: [{ oldText: "x", newText: "y" }],
          },
        ],
      }),
    );
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({})) as ApplyResult;
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);

    // The created file should be rolled back (deleted)
    const readResult = await backend.read("/new.ts");
    expect(readResult.ok).toBe(false);
  });

  test("rollback restores original content for edits", async () => {
    const originalContent = 'export const version = "1.0.0";';
    const backend = createMockBackend({
      "/src/index.ts": originalContent,
    });
    const store = createPlanStore();
    store.set(
      makePlan({
        steps: [
          {
            kind: "edit",
            path: "/src/index.ts",
            edits: [{ oldText: '"1.0.0"', newText: '"2.0.0"' }],
          },
          {
            kind: "edit",
            path: "/nonexistent.ts",
            edits: [{ oldText: "x", newText: "y" }],
          },
        ],
      }),
    );
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({})) as ApplyResult;
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);

    // index.ts should be restored to original
    const readResult = await backend.read("/src/index.ts");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe(originalContent);
    }
  });

  test("rollback recreates deleted file", async () => {
    const originalContent = "file to delete";
    const backend = createMockBackend({
      "/delete-me.ts": originalContent,
    });
    const store = createPlanStore();
    store.set(
      makePlan({
        steps: [
          { kind: "delete", path: "/delete-me.ts" },
          { kind: "create", path: "/new.ts", content: "new content" },
          // Third step will fail — file doesn't exist
          {
            kind: "edit",
            path: "/missing.ts",
            edits: [{ oldText: "x", newText: "y" }],
          },
        ],
      }),
    );
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({})) as ApplyResult;
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);

    // Deleted file should be recreated
    const readResult = await backend.read("/delete-me.ts");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe(originalContent);
    }

    // Created file should be deleted
    const newResult = await backend.read("/new.ts");
    expect(newResult.ok).toBe(false);
  });

  test("rollback failure is reported but does not crash", async () => {
    // Use a backend that succeeds on create but fails on delete (rollback of create)
    const mockBackend = createMockBackend();

    // Override write to fail on second step only
    /* let justified: mutable call counter */
    let writeCallCount = 0;
    const originalWrite = mockBackend.write;
    const { delete: _del, ...rest } = mockBackend;
    const limitedBackend: typeof mockBackend = {
      ...(rest as typeof mockBackend),
      write: (
        path: string,
        content: string,
        options?: { readonly createDirectories?: boolean; readonly overwrite?: boolean },
      ) => {
        writeCallCount++;
        if (writeCallCount === 2) {
          return {
            ok: false as const,
            error: { code: "INTERNAL" as const, message: "disk full", retryable: false },
          };
        }
        return originalWrite(path, content, options);
      },
      // delete removed via destructuring so rollback of first create also fails
    };

    const store = createPlanStore();
    store.set(
      makePlan({
        steps: [
          { kind: "create", path: "/a.ts", content: "file a" },
          { kind: "create", path: "/b.ts", content: "file b" },
        ],
      }),
    );

    const tool = createPlanApplyTool(limitedBackend, store, "code_plan", "verified");
    const result = (await tool.execute({})) as ApplyResult;

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.rollbackErrors.length).toBeGreaterThan(0);
  });

  test("successful plan has rolledBack false", async () => {
    const backend = createMockBackend();
    const store = createPlanStore();
    store.set(makePlan());
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({})) as ApplyResult;
    expect(result.success).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.rollbackErrors).toEqual([]);
  });

  test("detects stale files and marks plan failed", async () => {
    const backend = createMockBackend({
      "/src/index.ts": "changed content",
    });
    const store = createPlanStore();
    // Plan was created with hash of "original content"
    store.set(
      makePlan({
        steps: [
          {
            kind: "edit",
            path: "/src/index.ts",
            edits: [{ oldText: "original", newText: "updated" }],
          },
        ],
        hashes: [{ path: "/src/index.ts", hash: 999999 }],
      }),
    );
    const tool = createPlanApplyTool(backend, store, "code_plan", "verified");

    const result = (await tool.execute({})) as { error: string; code: string };
    expect(result.code).toBe("STALE_REF");
    expect(store.get()?.state).toBe("failed");
  });
});
