/**
 * Integration test — full create → status → apply → status lifecycle.
 */

import { describe, expect, test } from "bun:test";
import { createPlanStore } from "../plan-store.js";
import { createMockBackend } from "../test-helpers.js";
import { createPlanApplyTool } from "../tools/plan-apply.js";
import { createPlanCreateTool } from "../tools/plan-create.js";
import { createPlanStatusTool } from "../tools/plan-status.js";
import type { ApplyResult, PlanPreview, PlanStatus } from "../types.js";

function createToolset(files: Record<string, string> = {}) {
  const backend = createMockBackend(files);
  const store = createPlanStore();
  return {
    create: createPlanCreateTool(backend, store, "code_plan", "verified"),
    apply: createPlanApplyTool(backend, store, "code_plan", "verified"),
    status: createPlanStatusTool(store, "code_plan", "verified"),
    backend,
    store,
  };
}

describe("plan lifecycle", () => {
  test("full round-trip: create → status → apply → status", async () => {
    const tools = createToolset({
      "/src/index.ts": 'export const version = "1.0.0";',
    });

    // 1. Create plan
    const preview = (await tools.create.execute({
      steps: [
        {
          kind: "edit",
          path: "/src/index.ts",
          edits: [{ oldText: '"1.0.0"', newText: '"2.0.0"' }],
          description: "bump version",
        },
        { kind: "create", path: "/CHANGELOG.md", content: "# v2.0.0\n- Bumped version" },
      ],
    })) as PlanPreview;

    expect(preview.planId).toBeDefined();
    expect(preview.summary).toBe("2 files: 1 create, 1 edit");
    expect(preview.files.length).toBe(2);

    // 2. Check status — should be pending
    const status1 = (await tools.status.execute({})) as PlanStatus;
    expect(status1.state).toBe("pending");
    expect(status1.stepCount).toBe(2);
    expect(status1.planId).toBe(preview.planId);

    // 3. Apply
    const result = (await tools.apply.execute({
      planId: preview.planId,
    })) as ApplyResult;

    expect(result.success).toBe(true);
    expect(result.planId).toBe(preview.planId);
    expect(result.steps.length).toBe(2);
    expect(result.steps.every((s) => s.success)).toBe(true);

    // 4. Check status — should be applied
    const status2 = (await tools.status.execute({})) as PlanStatus;
    expect(status2.state).toBe("applied");

    // 5. Verify files were modified
    const indexResult = await tools.backend.read("/src/index.ts");
    if (indexResult.ok) {
      expect(indexResult.value.content).toContain('"2.0.0"');
    }
    const changelogResult = await tools.backend.read("/CHANGELOG.md");
    if (changelogResult.ok) {
      expect(changelogResult.value.content).toContain("v2.0.0");
    }
  });

  test("new plan discards old plan", async () => {
    const tools = createToolset();

    // Create first plan
    const first = (await tools.create.execute({
      steps: [{ kind: "create", path: "/a.ts", content: "a" }],
    })) as PlanPreview;

    // Create second plan — discards first
    const second = (await tools.create.execute({
      steps: [{ kind: "create", path: "/b.ts", content: "b" }],
    })) as PlanPreview;

    expect(first.planId).not.toBe(second.planId);

    // Status should reflect second plan
    const status = (await tools.status.execute({})) as PlanStatus;
    expect(status.planId).toBe(second.planId);

    // Apply should succeed for second plan
    const result = (await tools.apply.execute({})) as ApplyResult;
    expect(result.success).toBe(true);
    expect(result.planId).toBe(second.planId);
  });

  test("full round-trip with create + edit + delete", async () => {
    const tools = createToolset({
      "/src/index.ts": 'export const version = "1.0.0";',
      "/src/legacy.ts": "// deprecated",
    });

    // 1. Create plan with all three step kinds
    const preview = (await tools.create.execute({
      steps: [
        {
          kind: "edit",
          path: "/src/index.ts",
          edits: [{ oldText: '"1.0.0"', newText: '"2.0.0"' }],
          description: "bump version",
        },
        { kind: "create", path: "/CHANGELOG.md", content: "# v2.0.0\n- Bumped version" },
        { kind: "delete", path: "/src/legacy.ts", description: "remove deprecated file" },
      ],
    })) as PlanPreview;

    expect(preview.planId).toBeDefined();
    expect(preview.summary).toBe("3 files: 1 create, 1 edit, 1 delete");

    // 2. Apply
    const result = (await tools.apply.execute({
      planId: preview.planId,
    })) as ApplyResult;

    expect(result.success).toBe(true);
    expect(result.steps.length).toBe(3);
    expect(result.steps.every((s) => s.success)).toBe(true);
    expect(result.rolledBack).toBe(false);

    // 3. Verify
    const indexResult = await tools.backend.read("/src/index.ts");
    if (indexResult.ok) {
      expect(indexResult.value.content).toContain('"2.0.0"');
    }
    const legacyResult = await tools.backend.read("/src/legacy.ts");
    expect(legacyResult.ok).toBe(false);

    const changelogResult = await tools.backend.read("/CHANGELOG.md");
    if (changelogResult.ok) {
      expect(changelogResult.value.content).toContain("v2.0.0");
    }
  });

  test("cannot apply twice", async () => {
    const tools = createToolset();

    await tools.create.execute({
      steps: [{ kind: "create", path: "/f.ts", content: "hello" }],
    });

    // First apply
    const first = (await tools.apply.execute({})) as ApplyResult;
    expect(first.success).toBe(true);

    // Second apply — should fail
    const second = (await tools.apply.execute({})) as { error: string; code: string };
    expect(second.code).toBe("CONFLICT");
  });
});
