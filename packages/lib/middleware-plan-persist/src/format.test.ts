/**
 * Tests for plan-file markdown serializer/parser, slug, and timestamp helpers.
 */

import { describe, expect, test } from "bun:test";
import {
  generatePlanMarkdown,
  generateSlug,
  generateTimestamp,
  parsePlanMarkdown,
  validateSlug,
} from "./format.js";
import type { PlanItem } from "./types.js";

const META = {
  generated: "2026-04-17T10:23:00.000Z",
  sessionId: "sess-1",
  epoch: 1,
  turnIndex: 7,
} as const;

describe("generatePlanMarkdown", () => {
  test("renders frontmatter, heading, and items in canonical order", () => {
    const items: readonly PlanItem[] = [
      { content: "First", status: "pending" },
      { content: "Second", status: "in_progress" },
      { content: "Third", status: "completed" },
    ];
    expect(generatePlanMarkdown(items, META)).toBe(
      [
        "---",
        "generated: 2026-04-17T10:23:00.000Z",
        "sessionId: sess-1",
        "epoch: 1",
        "turnIndex: 7",
        "---",
        "# Plan",
        "",
        "- [ ] First",
        "- [in_progress] Second",
        "- [x] Third",
        "",
      ].join("\n"),
    );
  });

  test("escapes triple backticks and collapses newlines so items cannot break the fence", () => {
    const items: readonly PlanItem[] = [
      { content: "danger ``` malicious", status: "pending" },
      { content: "multi\nline\nitem", status: "pending" },
    ];
    const md = generatePlanMarkdown(items, META);
    expect(md).toContain("- [ ] danger ''' malicious");
    expect(md).toContain("- [ ] multi line item");
  });

  test("empty plan emits frontmatter and heading but no items", () => {
    const md = generatePlanMarkdown([], META);
    expect(md).toContain("# Plan\n");
    expect(md).not.toContain("- [");
  });
});

describe("parsePlanMarkdown", () => {
  test("round-trips a generated plan to identical items", () => {
    const items: readonly PlanItem[] = [
      { content: "First", status: "pending" },
      { content: "Second", status: "in_progress" },
      { content: "Third", status: "completed" },
    ];
    const md = generatePlanMarkdown(items, META);
    const parsed = parsePlanMarkdown(md);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.items).toEqual(items);
    }
  });

  test("accepts uppercase [X] as completed (CommonMark tolerance)", () => {
    const md = "---\ngenerated: x\n---\n# Plan\n\n- [X] done\n";
    const parsed = parsePlanMarkdown(md);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.items).toEqual([{ content: "done", status: "completed" }]);
    }
  });

  test("tolerates files with no frontmatter", () => {
    const md = "# Plan\n\n- [ ] first\n";
    const parsed = parsePlanMarkdown(md);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.items).toEqual([{ content: "first", status: "pending" }]);
    }
  });

  test("rejects unknown status box", () => {
    const md = "# Plan\n\n- [skipped] item\n";
    const parsed = parsePlanMarkdown(md);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("unknown status");
    }
  });

  test("rejects empty content", () => {
    const md = "# Plan\n\n- [ ]    \n";
    const parsed = parsePlanMarkdown(md);
    expect(parsed.ok).toBe(false);
  });

  test("rejects unclosed frontmatter", () => {
    const md = "---\ngenerated: x\n# Plan\n- [ ] first\n";
    const parsed = parsePlanMarkdown(md);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("frontmatter not closed");
    }
  });

  test("rejects non-list, non-heading body lines", () => {
    const md = "# Plan\n\nrandom prose\n- [ ] first\n";
    const parsed = parsePlanMarkdown(md);
    expect(parsed.ok).toBe(false);
  });
});

describe("validateSlug", () => {
  test("accepts simple lowercase slug", () => {
    expect(validateSlug("auth-refactor")).toEqual({ ok: true, slug: "auth-refactor" });
  });

  test("accepts single segment", () => {
    expect(validateSlug("auth")).toEqual({ ok: true, slug: "auth" });
  });

  test.each([
    ["empty", ""],
    ["uppercase", "Auth"],
    ["leading dash", "-auth"],
    ["trailing dash", "auth-"],
    ["double dash", "auth--refactor"],
    ["underscore", "auth_refactor"],
    ["slash", "auth/refactor"],
    ["dot-dot", ".."],
    ["nul byte", "auth\u0000refactor"],
    ["space", "auth refactor"],
    ["unicode bypass", "auth\u002frefactor"],
  ])("rejects invalid slug: %s", (_label, input) => {
    const result = validateSlug(input);
    expect(result.ok).toBe(false);
  });

  test("rejects slug longer than 48 characters", () => {
    const result = validateSlug("a".repeat(49));
    expect(result.ok).toBe(false);
  });
});

describe("generateSlug", () => {
  test("produces a slug that passes validateSlug", () => {
    let i = 0;
    const rand = (): number => {
      const seq = [0.1, 0.5];
      const v = seq[i % seq.length] ?? 0;
      i++;
      return v;
    };
    const slug = generateSlug(rand);
    expect(validateSlug(slug).ok).toBe(true);
  });
});

describe("generateTimestamp", () => {
  test("formats UTC date as YYYYMMDD-HHmmss", () => {
    const date = new Date(Date.UTC(2026, 3, 17, 10, 23, 7));
    expect(generateTimestamp(date)).toBe("20260417-102307");
  });

  test("zero-pads single-digit fields", () => {
    const date = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(generateTimestamp(date)).toBe("20260101-000000");
  });
});
