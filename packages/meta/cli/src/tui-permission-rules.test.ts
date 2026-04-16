/**
 * Regression test for #1845 — tool calls timed out at 30s because the TUI
 * used the 30s agent-to-agent default instead of a 60-minute interactive
 * approval timeout.
 *
 * Also verifies that destructive tools (memory_delete, notebook mutations)
 * still require approval while non-destructive tools are auto-allowed.
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

  describe("non-destructive memory tools — auto-allowed", () => {
    test("memory_store is allowed", () => {
      expect(checkTool(backend, "memory_store")).toBe("allow");
    });

    test("memory_recall is allowed", () => {
      expect(checkTool(backend, "memory_recall")).toBe("allow");
    });

    test("memory_search is allowed", () => {
      expect(checkTool(backend, "memory_search")).toBe("allow");
    });
  });

  describe("tools requiring approval (#1845 — now works with 60m timeout)", () => {
    test("memory_delete requires approval (deletes durable on-disk state)", () => {
      expect(checkTool(backend, "memory_delete")).toBe("ask");
    });

    test("notebook_read requires approval (filesystem read, must respect filesystemOperations gate)", () => {
      expect(checkTool(backend, "notebook_read")).toBe("ask");
    });

    test("notebook_add_cell requires approval (writes .ipynb in-place)", () => {
      expect(checkTool(backend, "notebook_add_cell")).toBe("ask");
    });

    test("notebook_replace_cell requires approval (writes .ipynb in-place)", () => {
      expect(checkTool(backend, "notebook_replace_cell")).toBe("ask");
    });

    test("notebook_delete_cell requires approval (writes .ipynb in-place)", () => {
      expect(checkTool(backend, "notebook_delete_cell")).toBe("ask");
    });

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
    // This is the primary fix for #1845: the 30s default caused approval
    // prompts to time out before interactive users could respond.
    expect(TUI_APPROVAL_TIMEOUT_MS).toBe(3_600_000);
  });
});
