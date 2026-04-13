import { describe, expect, test } from "bun:test";
import { formatInputPreview, processPermissionKey, truncateReason } from "./PermissionPrompt.js";

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
// truncateReason — keeps the safety-relevant reason visible at the approval
// boundary while bounding length so it doesn't crowd out the args block.
// (#1759 review balance)
// ---------------------------------------------------------------------------

describe("truncateReason", () => {
  test("returns short reasons unchanged", () => {
    expect(truncateReason("No matching permission rule")).toBe("No matching permission rule");
  });

  test("collapses internal whitespace", () => {
    expect(truncateReason("AST  walker\n  failed")).toBe("AST walker failed");
  });

  test("truncates to maxLength with ellipsis", () => {
    const long = "x".repeat(500);
    const out = truncateReason(long, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });

  test("default maxLength is 120 chars", () => {
    const long = "y".repeat(500);
    const out = truncateReason(long);
    expect(out.length).toBe(120);
  });
});
