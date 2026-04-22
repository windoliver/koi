import { describe, expect, test } from "bun:test";
import {
  formatInputPreview,
  normalizeReason,
  PERMISSION_PROMPT_WIDTH,
  processPermissionKey,
} from "./PermissionPrompt.js";

// ---------------------------------------------------------------------------
// PERMISSION_PROMPT_WIDTH — layout contract (#1913)
// ---------------------------------------------------------------------------

describe("PERMISSION_PROMPT_WIDTH", () => {
  test("is a finite positive integer — OpenTUI busy-loop guard", () => {
    // Regression: #1913 — PermissionPrompt was the only modal without an
    // explicit width. OpenTUI re-measures undimensioned absolute boxes every
    // layout pass; the blendCells path saturated one CPU core and blocked all
    // key input. This constant MUST be a finite positive integer and MUST be
    // applied to the outer <box> for the fix to hold.
    expect(typeof PERMISSION_PROMPT_WIDTH).toBe("number");
    expect(Number.isFinite(PERMISSION_PROMPT_WIDTH)).toBe(true);
    expect(PERMISSION_PROMPT_WIDTH).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// processPermissionKey
// ---------------------------------------------------------------------------

describe("processPermissionKey", () => {
  test("'y' returns allow", () => {
    expect(processPermissionKey("y")).toEqual({ kind: "allow" });
  });

  test("'n' returns deny with reason", () => {
    expect(processPermissionKey("n")).toEqual({ kind: "deny", reason: "User denied" });
  });

  test("'a' returns always-allow with session scope", () => {
    expect(processPermissionKey("a")).toEqual({ kind: "always-allow", scope: "session" });
  });

  test("'escape' returns deny with dismiss reason", () => {
    expect(processPermissionKey("escape")).toEqual({ kind: "deny", reason: "User dismissed" });
  });

  test("unknown key returns null (focus trap swallows)", () => {
    expect(processPermissionKey("x")).toBeNull();
    expect(processPermissionKey("return")).toBeNull();
    expect(processPermissionKey("tab")).toBeNull();
    expect(processPermissionKey("space")).toBeNull();
  });

  test("uppercase Y/N/A are accepted (case-insensitive)", () => {
    expect(processPermissionKey("Y")).toEqual({ kind: "allow" });
    expect(processPermissionKey("N")).toEqual({ kind: "deny", reason: "User denied" });
    expect(processPermissionKey("A")).toEqual({ kind: "always-allow", scope: "session" });
  });
});

// ---------------------------------------------------------------------------
// formatInputPreview
// ---------------------------------------------------------------------------

describe("formatInputPreview", () => {
  test("short input is returned as-is", () => {
    const result = formatInputPreview({ cmd: "ls" });
    expect(result).toBe('{\n  "cmd": "ls"\n}');
  });

  test("empty object", () => {
    expect(formatInputPreview({})).toBe("{}");
  });

  test("long input is truncated with ellipsis", () => {
    const longObj: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      longObj[`key_${i}`] = "x".repeat(20);
    }
    const result = formatInputPreview(longObj, 100);
    expect(result.length).toBeLessThanOrEqual(106); // 100 + "\n  ..."
    expect(result).toContain("...");
  });

  test("respects custom maxLength", () => {
    const result = formatInputPreview({ a: "b", c: "d" }, 10);
    expect(result.length).toBeLessThanOrEqual(16);
    expect(result).toContain("...");
  });
});

// ---------------------------------------------------------------------------
// normalizeReason — preserves the FULL reason text at the approval boundary
// while collapsing whitespace so the prompt UI can render it cleanly. No
// truncation: long reasons must remain visible because the distinguishing
// detail can be at the end of the string. (#1759 review round 8)
// ---------------------------------------------------------------------------

describe("normalizeReason", () => {
  test("returns short reasons unchanged", () => {
    expect(normalizeReason("No matching permission rule")).toBe("No matching permission rule");
  });

  test("collapses internal whitespace", () => {
    expect(normalizeReason("AST  walker\n  failed")).toBe("AST walker failed");
  });

  test("preserves the full reason text — does NOT truncate", () => {
    const long = "x".repeat(500);
    const out = normalizeReason(long);
    expect(out.length).toBe(500);
    expect(out).toBe(long);
  });

  test("preserves a long policy reason verbatim including the trailing detail", () => {
    const reason =
      "AST walker cannot safely analyse this command (declaration_command): unsupported statement: declare -i x=10";
    const out = normalizeReason(reason);
    // The distinguishing trailing detail must survive normalization.
    expect(out).toContain("declare -i x=10");
    expect(out.length).toBe(reason.length);
  });
});
