import { describe, expect, test } from "bun:test";
import { agentId as toAgentId } from "@koi/core";
import type { PolicyRequest } from "@koi/core/governance-backend";
import { createPatternBackend } from "../pattern-backend.js";

function req(
  overrides: {
    readonly kind?: PolicyRequest["kind"];
    readonly payload?: PolicyRequest["payload"];
  } = {},
): PolicyRequest {
  return {
    kind: overrides.kind ?? "tool_call",
    agentId: toAgentId("a1"),
    payload: overrides.payload ?? {},
    timestamp: 1000,
  };
}

describe("createPatternBackend", () => {
  describe("rule matching", () => {
    test("allows by default when no rules and no defaultDeny", async () => {
      const backend = createPatternBackend({ rules: [] });
      const result = await backend.evaluator.evaluate(req());
      expect(result).toEqual({ ok: true });
    });

    test("denies when defaultDeny and no rule matches", async () => {
      const backend = createPatternBackend({ rules: [], defaultDeny: true });
      const result = await backend.evaluator.evaluate(req());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.violations[0]?.rule).toBe("default-deny");
      }
    });

    test("matches by kind", async () => {
      const backend = createPatternBackend({
        rules: [{ match: { kind: "model_call" }, decision: "deny" }],
      });
      const deny = await backend.evaluator.evaluate(req({ kind: "model_call" }));
      const allow = await backend.evaluator.evaluate(req({ kind: "tool_call" }));
      expect(deny.ok).toBe(false);
      expect(allow.ok).toBe(true);
    });

    test("matches by toolId for tool_call payloads", async () => {
      const backend = createPatternBackend({
        rules: [{ match: { toolId: "Bash" }, decision: "deny" }],
      });
      const denied = await backend.evaluator.evaluate(
        req({ kind: "tool_call", payload: { toolId: "Bash" } }),
      );
      const allowed = await backend.evaluator.evaluate(
        req({ kind: "tool_call", payload: { toolId: "Read" } }),
      );
      expect(denied.ok).toBe(false);
      expect(allowed.ok).toBe(true);
    });

    test("matches by model for model_call payloads", async () => {
      const backend = createPatternBackend({
        rules: [{ match: { model: "gpt-4o" }, decision: "deny" }],
      });
      const denied = await backend.evaluator.evaluate(
        req({ kind: "model_call", payload: { model: "gpt-4o" } }),
      );
      const allowed = await backend.evaluator.evaluate(
        req({ kind: "model_call", payload: { model: "claude-sonnet-4-6" } }),
      );
      expect(denied.ok).toBe(false);
      expect(allowed.ok).toBe(true);
    });

    test("last-match-wins precedence", async () => {
      const backend = createPatternBackend({
        rules: [
          { match: { toolId: "Bash" }, decision: "deny" },
          { match: { toolId: "Bash" }, decision: "allow" },
        ],
      });
      const result = await backend.evaluator.evaluate(
        req({ kind: "tool_call", payload: { toolId: "Bash" } }),
      );
      expect(result.ok).toBe(true);
    });

    test("match object with multiple fields is AND", async () => {
      const backend = createPatternBackend({
        rules: [
          {
            match: { kind: "tool_call", toolId: "fs_write" },
            decision: "deny",
          },
        ],
      });
      const matched = await backend.evaluator.evaluate(
        req({ kind: "tool_call", payload: { toolId: "fs_write" } }),
      );
      expect(matched.ok).toBe(false);

      const otherKind = await backend.evaluator.evaluate(
        req({ kind: "spawn", payload: { toolId: "fs_write" } }),
      );
      expect(otherKind.ok).toBe(true);
    });
  });

  describe("violation shape", () => {
    test("deny surfaces custom rule, severity, and message", async () => {
      const backend = createPatternBackend({
        rules: [
          {
            match: { toolId: "Bash" },
            decision: "deny",
            rule: "no-shell",
            severity: "warning",
            message: "shell access is not permitted in this environment",
          },
        ],
      });
      const result = await backend.evaluator.evaluate(
        req({ kind: "tool_call", payload: { toolId: "Bash" } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const violation = result.violations[0];
        expect(violation?.rule).toBe("no-shell");
        expect(violation?.severity).toBe("warning");
        expect(violation?.message).toBe("shell access is not permitted in this environment");
      }
    });

    test("deny defaults severity to critical and fills rule id", async () => {
      const backend = createPatternBackend({
        rules: [{ match: { toolId: "Bash" }, decision: "deny" }],
      });
      const result = await backend.evaluator.evaluate(
        req({ kind: "tool_call", payload: { toolId: "Bash" } }),
      );
      if (!result.ok) {
        expect(result.violations[0]?.severity).toBe("critical");
        expect(result.violations[0]?.rule).toBe("pattern.0");
      }
    });
  });
});
