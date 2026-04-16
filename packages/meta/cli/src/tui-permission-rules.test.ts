/**
 * Regression test for #1845 — memory_delete and notebook_delete_cell
 * must be auto-allowed in the TUI permission rules, just like their
 * sibling CRUD tools (memory_store, notebook_add_cell, etc.).
 *
 * Also verifies the TUI passes an interactive-length approval timeout
 * rather than the 30s agent-to-agent default.
 */

import { describe, expect, test } from "bun:test";
import type { PermissionQuery } from "@koi/core";
import { createPermissionBackend } from "@koi/permissions";
import { TUI_ALLOW_RULES, TUI_APPROVAL_TIMEOUT_MS } from "./runtime-factory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkTool(backend: ReturnType<typeof createPermissionBackend>, toolId: string): string {
  const query: PermissionQuery = {
    principal: "agent:tui",
    action: "invoke",
    resource: toolId,
  };
  const decision = backend.check(query);
  // check returns PermissionDecision | Promise<PermissionDecision>
  if (decision instanceof Promise) throw new Error("Expected sync decision");
  return decision.effect;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TUI permission rules (#1845)", () => {
  const backend = createPermissionBackend({
    mode: "default",
    rules: [...TUI_ALLOW_RULES],
  });

  describe("memory tools — all auto-allowed (sandboxed to .koi/memory/)", () => {
    test("memory_store is allowed", () => {
      expect(checkTool(backend, "memory_store")).toBe("allow");
    });

    test("memory_recall is allowed", () => {
      expect(checkTool(backend, "memory_recall")).toBe("allow");
    });

    test("memory_search is allowed", () => {
      expect(checkTool(backend, "memory_search")).toBe("allow");
    });

    test("memory_delete is allowed (#1845)", () => {
      expect(checkTool(backend, "memory_delete")).toBe("allow");
    });
  });

  describe("notebook tools — all auto-allowed (file-path tools, sandboxed)", () => {
    test("notebook_read is allowed", () => {
      expect(checkTool(backend, "notebook_read")).toBe("allow");
    });

    test("notebook_add_cell is allowed", () => {
      expect(checkTool(backend, "notebook_add_cell")).toBe("allow");
    });

    test("notebook_replace_cell is allowed", () => {
      expect(checkTool(backend, "notebook_replace_cell")).toBe("allow");
    });

    test("notebook_delete_cell is allowed (#1845)", () => {
      expect(checkTool(backend, "notebook_delete_cell")).toBe("allow");
    });
  });

  describe("dangerous tools stay gated", () => {
    test("Bash requires approval", () => {
      expect(checkTool(backend, "Bash")).toBe("ask");
    });

    test("fs_write requires approval", () => {
      expect(checkTool(backend, "fs_write")).toBe("ask");
    });

    test("web_fetch requires approval", () => {
      expect(checkTool(backend, "web_fetch")).toBe("ask");
    });
  });
});

describe("TUI approval timeout (#1845)", () => {
  test("TUI uses 60-minute interactive timeout, not 30s agent default", () => {
    // 60 minutes = 3_600_000ms — documented in docs/L2/tui.md
    expect(TUI_APPROVAL_TIMEOUT_MS).toBe(3_600_000);
  });
});
