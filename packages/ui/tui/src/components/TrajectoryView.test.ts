import { describe, expect, test } from "bun:test";
import type { TrajectoryStepSummary } from "../state/types.js";
import { formatMwSpanSuffix, summarizeDecision } from "./TrajectoryView.js";

function makeStep(
  decisions: readonly Record<string, unknown>[] | undefined,
  nextCalled: boolean,
): TrajectoryStepSummary {
  return {
    stepIndex: 0,
    turnIndex: 0,
    kind: "model_call",
    identifier: "middleware:test",
    durationMs: 10,
    outcome: "success",
    timestamp: 0,
    requestText: undefined,
    responseText: undefined,
    errorText: undefined,
    tokens: undefined,
    middlewareSpan: { hook: "wrapModelCall", phase: "resolve", nextCalled, decisions },
  };
}

describe("summarizeDecision", () => {
  describe("model-router decisions", () => {
    test("shows selected target without fallback", () => {
      const result = summarizeDecision({
        "router.target.selected": "openai:gpt-4o",
        "router.target.attempted": ["openai:gpt-4o"],
        "router.fallback_occurred": false,
        "router.latency_ms": 120,
      });
      expect(result).toBe("→openai:gpt-4o");
    });

    test("appends fallback suffix when fallback_occurred is true", () => {
      const result = summarizeDecision({
        "router.target.selected": "anthropic:claude-3-haiku",
        "router.target.attempted": ["openai:gpt-4o", "anthropic:claude-3-haiku"],
        "router.fallback_occurred": true,
        "router.latency_ms": 340,
      });
      expect(result).toBe("→anthropic:claude-3-haiku fallback");
    });

    test("shows exhausted when selected is empty string", () => {
      const result = summarizeDecision({
        "router.target.selected": "",
        "router.target.attempted": ["openai:gpt-4o"],
        "router.fallback_occurred": false,
        "router.latency_ms": 50,
      });
      expect(result).toBe("exhausted");
    });

    test("exhausted with fallback_occurred true shows exhausted without fallback suffix", () => {
      // all targets failed — fallback was attempted but also failed; "fallback" suffix would be misleading
      const result = summarizeDecision({
        "router.target.selected": "",
        "router.target.attempted": ["openai:gpt-4o", "anthropic:claude-3-haiku"],
        "router.fallback_occurred": true,
      });
      expect(result).toBe("exhausted");
    });

    test("truncates long model IDs to 24 chars with ellipsis", () => {
      // "openrouter:google/gemini-2.0-flash-001" is 38 chars — slice(0,23) + "…" = 24 visible chars
      const result = summarizeDecision({
        "router.target.selected": "openrouter:google/gemini-2.0-flash-001",
        "router.fallback_occurred": false,
      });
      expect(result).toBe("→openrouter:google/gemin…");
    });

    test("truncates long model IDs with fallback suffix", () => {
      const result = summarizeDecision({
        "router.target.selected": "openrouter:google/gemini-2.0-flash-001",
        "router.fallback_occurred": true,
      });
      expect(result).toBe("→openrouter:google/gemin… fallback");
    });

    test("returns undefined for unrecognized decision shape", () => {
      const result = summarizeDecision({ unknownKey: "value" });
      expect(result).toBeUndefined();
    });
  });

  describe("existing decision types are unaffected", () => {
    test("permissions filter phase", () => {
      expect(summarizeDecision({ phase: "filter", allowedCount: 3, totalTools: 5 })).toBe(
        "filter:3/5",
      );
    });

    test("permissions execute phase", () => {
      expect(summarizeDecision({ phase: "execute", action: "allow", toolId: "bash" })).toBe(
        "allow:bash",
      );
    });

    test("checkpoint capture", () => {
      expect(summarizeDecision({ action: "capture", captured: true, path: "/tmp/ckpt" })).toBe(
        "capture:/tmp/ckpt",
      );
    });
  });
});

describe("formatMwSpanSuffix", () => {
  test("router decision with nextCalled false is NOT labeled BLOCKED (terminal handler)", () => {
    const step = makeStep(
      [{ "router.target.selected": "openai:gpt-4o", "router.fallback_occurred": false }],
      false,
    );
    expect(formatMwSpanSuffix(step)).toBe("→openai:gpt-4o");
  });

  test("non-router decision with nextCalled false IS labeled BLOCKED", () => {
    const step = makeStep([{ phase: "execute", action: "deny", toolId: "bash" }], false);
    expect(formatMwSpanSuffix(step)).toBe("deny:bash BLOCKED");
  });

  test("router decision with nextCalled true shows summary without BLOCKED suffix", () => {
    const step = makeStep(
      [
        {
          "router.target.selected": "anthropic:claude-3-haiku",
          "router.fallback_occurred": true,
        },
      ],
      true,
    );
    expect(formatMwSpanSuffix(step)).toBe("→anthropic:claude-3-haiku fallback");
  });

  test("no decisions and nextCalled false shows BLOCKED", () => {
    expect(formatMwSpanSuffix(makeStep(undefined, false))).toBe("BLOCKED");
  });

  test("no decisions and nextCalled true shows pass", () => {
    expect(formatMwSpanSuffix(makeStep(undefined, true))).toBe("pass");
  });

  test("model-router with no decisions and nextCalled false shows exhausted (failed route, no decision emitted)", () => {
    // wrapModelCall throws before reportRouteDecision on exhaustion — identifier-based detection
    const step = { ...makeStep(undefined, false), identifier: "middleware:model-router" };
    expect(formatMwSpanSuffix(step)).toBe("exhausted");
  });
});
