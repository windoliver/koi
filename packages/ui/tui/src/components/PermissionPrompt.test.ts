import { describe, expect, test } from "bun:test";
import {
  computePermissionPromptWidth,
  formatInputPreview,
  normalizeReason,
  PERMISSION_PROMPT_WIDTH,
  processPermissionKey,
} from "./PermissionPrompt.js";

// ---------------------------------------------------------------------------
// computePermissionPromptWidth — layout contract (#1913)
// ---------------------------------------------------------------------------

// MODAL_POSITION.left = 2, BORDER_CHROME = 2 (shared constants, not re-exported).
// Invariant: left(2) + width + border(2) <= terminalCols for terminalCols >= 4.
const LEFT = 2;
const BORDER = 2;

describe("computePermissionPromptWidth", () => {
  test("returns PERMISSION_PROMPT_WIDTH on wide terminals", () => {
    // min breakpoint: left(2) + 60 + borders(2) = 64 cols needed.
    expect(computePermissionPromptWidth(100)).toBe(PERMISSION_PROMPT_WIDTH);
    expect(computePermissionPromptWidth(80)).toBe(PERMISSION_PROMPT_WIDTH);
    expect(computePermissionPromptWidth(64)).toBe(PERMISSION_PROMPT_WIDTH);
  });

  test("shrinks on narrow terminals so the full outer box fits", () => {
    // 60-col: width = 56 → outer box = 2 + 56 + 2 = 60 ✓
    expect(computePermissionPromptWidth(60)).toBeLessThan(PERMISSION_PROMPT_WIDTH);
    expect(computePermissionPromptWidth(60)).toBe(56);
    // 40-col: width = 36 → outer box = 2 + 36 + 2 = 40 ✓
    expect(computePermissionPromptWidth(40)).toBe(36);
    // 10-col: width = 6 → outer box = 2 + 6 + 2 = 10 ✓
    expect(computePermissionPromptWidth(10)).toBe(6);
  });

  test("never returns negative — clamps to 0 for pathologically narrow terminals", () => {
    expect(computePermissionPromptWidth(3)).toBe(0);
    expect(computePermissionPromptWidth(0)).toBe(0);
  });

  test("outer box fits invariant holds for all terminal widths 4..100", () => {
    for (let cols = 4; cols <= 100; cols++) {
      const w = computePermissionPromptWidth(cols);
      expect(LEFT + w + BORDER).toBeLessThanOrEqual(cols);
    }
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
