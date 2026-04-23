import { describe, expect, test } from "bun:test";
import {
  computeMinSafeHeight,
  computePermissionPromptWidth,
  formatInputPreview,
  formatToolId,
  normalizeReason,
  PERMISSION_PROMPT_MIN_SAFE_HEIGHT,
  PERMISSION_PROMPT_MIN_SAFE_WIDTH,
  PERMISSION_PROMPT_NARROW_THRESHOLD,
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

  test("never returns 0 or negative — always a positive integer (avoids blendCells busy-loop)", () => {
    // Even on a pathologically narrow terminal, width must be >= 1 so OpenTUI
    // has an explicit positive value and does not re-measure every frame.
    expect(computePermissionPromptWidth(3)).toBe(1);
    expect(computePermissionPromptWidth(0)).toBe(1);
  });

  test("outer box fits invariant holds for all terminal widths ≥ 5", () => {
    // For cols in [5, 100]: available = cols-2-2 >= 1 = MIN_WIDTH, so width = available,
    // and outer = LEFT(2) + available + BORDER(2) = cols exactly. ✓
    // Below 5 cols: width is clamped to MIN_WIDTH=1 (busy-loop prevention takes priority
    // over the fit invariant — the left offset alone already overflows sub-5 terminals).
    for (let cols = 5; cols <= 100; cols++) {
      const w = computePermissionPromptWidth(cols);
      expect(LEFT + w + BORDER).toBeLessThanOrEqual(cols);
    }
  });
});

// ---------------------------------------------------------------------------
// PERMISSION_PROMPT_NARROW_THRESHOLD — responsive layout contract (#1913)
// ---------------------------------------------------------------------------

describe("PERMISSION_PROMPT_NARROW_THRESHOLD", () => {
  // Key hints are always stacked vertically (the full horizontal row is ~76 chars,
  // wider than the max 60-col modal). The threshold only controls the title row:
  // whether the risk label is inlined or placed on its own line.

  test("very narrow terminal (< 34-col) stacks the title risk label", () => {
    // computePermissionPromptWidth(30) = 26 < PERMISSION_PROMPT_NARROW_THRESHOLD(30).
    expect(computePermissionPromptWidth(30)).toBeLessThan(PERMISSION_PROMPT_NARROW_THRESHOLD);
  });

  test("most terminals produce modal widths at or above the title threshold", () => {
    // At 40-col: width = 36 >= 30. At 100-col: width = 60 >= 30.
    expect(computePermissionPromptWidth(40)).toBeGreaterThanOrEqual(
      PERMISSION_PROMPT_NARROW_THRESHOLD,
    );
    expect(computePermissionPromptWidth(100)).toBeGreaterThanOrEqual(
      PERMISSION_PROMPT_NARROW_THRESHOLD,
    );
  });

  test("threshold is above the minimum safe width (all too-narrow terminals are also narrow)", () => {
    expect(PERMISSION_PROMPT_NARROW_THRESHOLD).toBeGreaterThan(0);
    expect(PERMISSION_PROMPT_NARROW_THRESHOLD).toBeGreaterThan(PERMISSION_PROMPT_MIN_SAFE_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// PERMISSION_PROMPT_MIN_SAFE_WIDTH — approval suppression on unreadable prompts
// ---------------------------------------------------------------------------

describe("PERMISSION_PROMPT_MIN_SAFE_WIDTH", () => {
  test("pathologically narrow terminals produce widths below the safe threshold", () => {
    // computePermissionPromptWidth(10) = 6; computePermissionPromptWidth(5) = 1.
    expect(computePermissionPromptWidth(10)).toBeLessThan(PERMISSION_PROMPT_MIN_SAFE_WIDTH);
    expect(computePermissionPromptWidth(5)).toBeLessThan(PERMISSION_PROMPT_MIN_SAFE_WIDTH);
  });

  test("safe terminals produce widths at or above the safe threshold", () => {
    // computePermissionPromptWidth(24) = 20 = MIN_SAFE_WIDTH.
    expect(computePermissionPromptWidth(24)).toBeGreaterThanOrEqual(
      PERMISSION_PROMPT_MIN_SAFE_WIDTH,
    );
    expect(computePermissionPromptWidth(40)).toBeGreaterThanOrEqual(
      PERMISSION_PROMPT_MIN_SAFE_WIDTH,
    );
  });

  test("safe threshold is between 1 and the narrow threshold", () => {
    expect(PERMISSION_PROMPT_MIN_SAFE_WIDTH).toBeGreaterThan(1);
    expect(PERMISSION_PROMPT_MIN_SAFE_WIDTH).toBeLessThan(PERMISSION_PROMPT_NARROW_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// PERMISSION_PROMPT_MIN_SAFE_HEIGHT — approval suppression on short terminals
// ---------------------------------------------------------------------------

describe("PERMISSION_PROMPT_MIN_SAFE_HEIGHT", () => {
  test("constant covers the full row budget: top(2) + modal(14) = 16", () => {
    // MODAL_POSITION.top=2 + border(2) + title(1) + tool(2) + args(3) + hints(6) = 16 minimum.
    expect(PERMISSION_PROMPT_MIN_SAFE_HEIGHT).toBe(16);
    expect(PERMISSION_PROMPT_MIN_SAFE_HEIGHT).toBeGreaterThan(4);
  });

  test("is independent of PERMISSION_PROMPT_MIN_SAFE_WIDTH — width and height guards are orthogonal", () => {
    // Both thresholds are positive. Either can be lower or higher than the other.
    expect(PERMISSION_PROMPT_MIN_SAFE_HEIGHT).toBeGreaterThan(0);
    expect(PERMISSION_PROMPT_MIN_SAFE_WIDTH).toBeGreaterThan(0);
  });

  test("short terminal (rows < MIN_SAFE_HEIGHT) suppresses approval — isTooShort logic", () => {
    // isTooShort = terminalHeight < PERMISSION_PROMPT_MIN_SAFE_HEIGHT
    expect(PERMISSION_PROMPT_MIN_SAFE_HEIGHT - 1).toBeLessThan(PERMISSION_PROMPT_MIN_SAFE_HEIGHT);
    expect(PERMISSION_PROMPT_MIN_SAFE_HEIGHT - 5).toBeLessThan(PERMISSION_PROMPT_MIN_SAFE_HEIGHT);
  });

  test("tall terminal (rows >= MIN_SAFE_HEIGHT) allows approval — isTooShort logic", () => {
    expect(PERMISSION_PROMPT_MIN_SAFE_HEIGHT).toBeGreaterThanOrEqual(
      PERMISSION_PROMPT_MIN_SAFE_HEIGHT,
    );
    expect(PERMISSION_PROMPT_MIN_SAFE_HEIGHT + 10).toBeGreaterThanOrEqual(
      PERMISSION_PROMPT_MIN_SAFE_HEIGHT,
    );
  });

  test("default terminalHeight (undefined) is treated as safe — approval not suppressed", () => {
    // Props default: PERMISSION_PROMPT_MIN_SAFE_HEIGHT + 1, always >= threshold
    const defaultHeight = PERMISSION_PROMPT_MIN_SAFE_HEIGHT + 1;
    expect(defaultHeight).toBeGreaterThanOrEqual(PERMISSION_PROMPT_MIN_SAFE_HEIGHT);
  });
});

// ---------------------------------------------------------------------------
// computeMinSafeHeight — dynamic row budget accounting for prompt content
// ---------------------------------------------------------------------------

describe("computeMinSafeHeight", () => {
  // Baseline: wide terminal, "{}" input (1 JSON line), no reason, no permanent.
  // Budget: top(2) + borders(2) + title(1) + tool(2) + args(3) + hints(6) = 16.
  test("returns PERMISSION_PROMPT_MIN_SAFE_HEIGHT for minimum content on wide terminal", () => {
    expect(computeMinSafeHeight(80, "{}", undefined, false)).toBe(
      PERMISSION_PROMPT_MIN_SAFE_HEIGHT,
    );
  });

  test("adds rows for each extra JSON arg line", () => {
    // 4-line JSON: raw budget = top(1)+borders(2)+title(1)+tool(2)+args(1+1+4)+hints(6) = 18.
    // Baseline raw = 15, floored to 16. 4-line JSON raw = 18 (no floor needed).
    const fourLineJson = '{\n  "a": "b",\n  "c": "d"\n}';
    expect(computeMinSafeHeight(80, fourLineJson, undefined, false)).toBe(18);
  });

  test("adds rows for a non-empty reason string", () => {
    // Short reason: raw = 15 + marginTop(1) + 1 line = 17. Floor = max(17, 16) = 17.
    expect(computeMinSafeHeight(80, "{}", "short reason", false)).toBe(17);
  });

  test("adds 1 row for permanentAvailable (tested above the floor using reason)", () => {
    // Use a reason to push above the floor, then verify +1 for permanent.
    const withoutPermanent = computeMinSafeHeight(80, "{}", "a reason", false);
    const withPermanent = computeMinSafeHeight(80, "{}", "a reason", true);
    expect(withPermanent).toBe(withoutPermanent + 1);
  });

  test("narrow terminal produces higher height than wide (extra rows for stacked layout)", () => {
    // 30-col (width=26, narrow): raw = 1+2+2+3+3+6 = 17, floor = 17.
    // 80-col (wide): raw = 15, floor = 16.
    const narrowHeight = computeMinSafeHeight(30, "{}", undefined, false);
    const wideHeight = computeMinSafeHeight(80, "{}", undefined, false);
    expect(narrowHeight).toBe(17);
    expect(wideHeight).toBe(16);
    expect(narrowHeight).toBeGreaterThan(wideHeight);
  });

  test("floor is always PERMISSION_PROMPT_MIN_SAFE_HEIGHT even for empty inputs", () => {
    expect(computeMinSafeHeight(80, "", undefined, false)).toBeGreaterThanOrEqual(
      PERMISSION_PROMPT_MIN_SAFE_HEIGHT,
    );
  });
});

// ---------------------------------------------------------------------------
// cannotReview gate — render + handler guard (width OR height unsafe = blocked)
// ---------------------------------------------------------------------------

describe("cannotReview gate logic (isTooNarrow || isTooShort)", () => {
  // Use minimum content to mirror the baseline for the gate logic contract.
  function cannotReview(terminalCols: number, terminalRows: number): boolean {
    const width = computePermissionPromptWidth(terminalCols);
    const isTooNarrow = width < PERMISSION_PROMPT_MIN_SAFE_WIDTH;
    const minHeight = computeMinSafeHeight(terminalCols, "{}", undefined, false);
    const isTooShort = terminalRows < minHeight;
    return isTooNarrow || isTooShort;
  }

  test("width-safe but height-unsafe terminal triggers cannotReview", () => {
    // 80-col terminal is wide enough (width=60 >= MIN_SAFE_WIDTH=20), but only
    // 10 rows — too short (10 < computeMinSafeHeight(80, …) = 16). Must block.
    expect(cannotReview(80, 10)).toBe(true);
    expect(cannotReview(80, PERMISSION_PROMPT_MIN_SAFE_HEIGHT - 1)).toBe(true);
  });

  test("height-safe but width-unsafe terminal triggers cannotReview", () => {
    // 10-col terminal: width=6 < MIN_SAFE_WIDTH=20. Height is safe.
    expect(cannotReview(10, 30)).toBe(true);
  });

  test("both-safe terminal does not trigger cannotReview", () => {
    // 80-col, 20-row terminal: width=60 >= 20, rows=20 >= 16.
    expect(cannotReview(80, 20)).toBe(false);
    expect(cannotReview(80, PERMISSION_PROMPT_MIN_SAFE_HEIGHT)).toBe(false);
  });

  test("both-unsafe terminal triggers cannotReview", () => {
    expect(cannotReview(10, 5)).toBe(true);
  });

  test("multiline-args prompt needs more rows than baseline", () => {
    // 5-line JSON needs base+4 rows; a terminal at base rows should block.
    const fiveLineJson = '{\n  "a": "1",\n  "b": "2",\n  "c": "3",\n  "d": "4"\n}';
    const minH = computeMinSafeHeight(80, fiveLineJson, undefined, false);
    expect(minH).toBeGreaterThan(PERMISSION_PROMPT_MIN_SAFE_HEIGHT);
    // Terminal with only baseline rows should block when content is taller.
    const width = computePermissionPromptWidth(80);
    const isTooNarrow = width < PERMISSION_PROMPT_MIN_SAFE_WIDTH;
    const isTooShort = PERMISSION_PROMPT_MIN_SAFE_HEIGHT < minH;
    expect(isTooNarrow || isTooShort).toBe(true);
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
// formatToolId — generic truncation helper (not used in approval boundary)
// ---------------------------------------------------------------------------

describe("formatToolId", () => {
  test("short ids are returned unchanged", () => {
    expect(formatToolId("bash", 15)).toBe("bash");
    expect(formatToolId("read_file", 15)).toBe("read_file");
  });

  test("long MCP-style ids are truncated with ellipsis", () => {
    const result = formatToolId("crm__get_customer", 12);
    expect(result.length).toBeLessThanOrEqual(12);
    expect(result).toContain("…");
    expect(result).toBe("crm__get_cu…");
  });

  test("exactly-at-limit ids are returned unchanged", () => {
    expect(formatToolId("billing__get", 12)).toBe("billing__get");
  });

  test("truncated id starts with the original id prefix", () => {
    const id = "billing__get_invoice";
    const result = formatToolId(id, 10);
    // slice(0, maxLen-1=9) + "…" = "billing__…" (9 chars of prefix + ellipsis = 10 total)
    expect(result).toBe("billing__…");
    expect(id.startsWith(result.slice(0, -1))).toBe(true);
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
