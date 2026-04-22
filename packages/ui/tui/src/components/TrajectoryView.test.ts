import { describe, expect, test } from "bun:test";
import { summarizeDecision } from "./TrajectoryView.js";

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
