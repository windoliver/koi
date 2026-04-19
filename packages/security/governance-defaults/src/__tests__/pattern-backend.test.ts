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
  const kind = overrides.kind ?? "tool_call";
  // Provide a well-formed default payload for kinds with required string
  // fields so tests that don't specifically exercise schema-fail-closed aren't
  // tripped by the schema check. Distinguish "payload omitted" from
  // "payload explicitly null/undefined" so malformed-payload tests actually
  // forward the malformed value.
  const defaultPayload: PolicyRequest["payload"] =
    kind === "tool_call"
      ? { toolId: "default-tool" }
      : kind === "model_call"
        ? { model: "default-model" }
        : {};
  const payload = "payload" in overrides ? overrides.payload : defaultPayload;
  return {
    kind,
    agentId: toAgentId("a1"),
    payload: payload as PolicyRequest["payload"],
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

    test("toolId selector only fires on tool_call kinds", async () => {
      const backend = createPatternBackend({
        rules: [{ match: { toolId: "Bash" }, decision: "deny" }],
      });
      // custom kind with same toolId in payload must NOT be denied by a
      // tool-scoped selector.
      const custom = await backend.evaluator.evaluate(
        req({ kind: "custom:foo", payload: { toolId: "Bash" } }),
      );
      expect(custom.ok).toBe(true);

      const spawn = await backend.evaluator.evaluate(
        req({ kind: "spawn", payload: { toolId: "Bash" } }),
      );
      expect(spawn.ok).toBe(true);
    });

    test("model selector only fires on model_call kinds", async () => {
      const backend = createPatternBackend({
        rules: [{ match: { model: "gpt-4o" }, decision: "deny" }],
      });
      const custom = await backend.evaluator.evaluate(
        req({ kind: "custom:foo", payload: { model: "gpt-4o" } }),
      );
      expect(custom.ok).toBe(true);
    });

    test("tool_call with non-string toolId fails closed with schema.invalid", async () => {
      const backend = createPatternBackend({
        rules: [{ match: { toolId: "Bash" }, decision: "deny" }],
      });
      const result = await backend.evaluator.evaluate(
        req({ kind: "tool_call", payload: { toolId: 42 } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.violations[0]?.rule).toBe("schema.invalid");
      }
    });

    test("tool_call with missing toolId fails closed", async () => {
      const backend = createPatternBackend({ rules: [] });
      const result = await backend.evaluator.evaluate(req({ kind: "tool_call", payload: {} }));
      expect(result.ok).toBe(false);
    });

    test("model_call with non-string model fails closed", async () => {
      const backend = createPatternBackend({
        rules: [{ match: { model: "gpt-4o" }, decision: "deny" }],
      });
      const result = await backend.evaluator.evaluate(
        req({ kind: "model_call", payload: { model: null } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.violations[0]?.rule).toBe("schema.invalid");
    });

    test("non-object payload (null) fails closed with schema.invalid on tool_call", async () => {
      const backend = createPatternBackend({ rules: [] });
      const result = await backend.evaluator.evaluate(
        req({ kind: "tool_call", payload: null as unknown as PolicyRequest["payload"] }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.violations[0]?.rule).toBe("schema.invalid");
    });

    test("array payload fails closed on tool_call", async () => {
      const backend = createPatternBackend({ rules: [] });
      const result = await backend.evaluator.evaluate(
        req({
          kind: "tool_call",
          payload: ["not", "an", "object"] as unknown as PolicyRequest["payload"],
        }),
      );
      expect(result.ok).toBe(false);
    });

    test("undefined payload fails closed on model_call", async () => {
      const backend = createPatternBackend({ rules: [] });
      const result = await backend.evaluator.evaluate(
        req({ kind: "model_call", payload: undefined as unknown as PolicyRequest["payload"] }),
      );
      expect(result.ok).toBe(false);
    });

    test("evaluator never throws on malformed payloads — always returns a verdict", async () => {
      const backend = createPatternBackend({
        rules: [{ match: { toolId: "Bash" }, decision: "deny" }],
      });
      // Throwing would route through generic backend-failure handling. We
      // want a structured schema.invalid verdict instead.
      for (const payload of [null, undefined, 42, "str", []]) {
        const result = await backend.evaluator.evaluate(
          req({
            kind: "tool_call",
            payload: payload as unknown as PolicyRequest["payload"],
          }),
        );
        expect(result.ok).toBe(false);
      }
    });

    test("schema check does not gate kinds without required selector fields", async () => {
      const backend = createPatternBackend({ rules: [] });
      // spawn / forge / custom:* have no required string selector.
      expect((await backend.evaluator.evaluate(req({ kind: "spawn", payload: {} }))).ok).toBe(true);
      expect((await backend.evaluator.evaluate(req({ kind: "forge", payload: {} }))).ok).toBe(true);
      expect((await backend.evaluator.evaluate(req({ kind: "custom:foo", payload: {} }))).ok).toBe(
        true,
      );
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
