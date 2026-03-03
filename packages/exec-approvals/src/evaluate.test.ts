import { describe, expect, test } from "bun:test";

import type { EvaluationConfig } from "./evaluate.js";
import { evaluateToolRequest } from "./evaluate.js";
import { defaultExtractCommand } from "./pattern.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<EvaluationConfig> = {}): EvaluationConfig {
  return {
    baseDeny: [],
    sessionDeny: [],
    sessionAllow: [],
    baseAllow: [],
    baseAsk: [],
    extractCommand: defaultExtractCommand,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 6-step evaluation order
// ---------------------------------------------------------------------------

describe("evaluateToolRequest", () => {
  test("step 1: base deny returns deny (absolute)", () => {
    const result = evaluateToolRequest("bash", {}, makeConfig({ baseDeny: ["bash"] }));
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("denied by policy");
    }
  });

  test("step 2: session deny returns deny", () => {
    const result = evaluateToolRequest("bash", {}, makeConfig({ sessionDeny: ["bash"] }));
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("denied by session policy");
    }
  });

  test("step 3: session allow returns allow", () => {
    const result = evaluateToolRequest("bash", {}, makeConfig({ sessionAllow: ["bash"] }));
    expect(result.kind).toBe("allow");
  });

  test("step 4: base allow returns allow", () => {
    const result = evaluateToolRequest("bash", {}, makeConfig({ baseAllow: ["bash"] }));
    expect(result.kind).toBe("allow");
  });

  test("step 5: base ask returns ask with matched pattern", () => {
    const result = evaluateToolRequest("bash", {}, makeConfig({ baseAsk: ["bash"] }));
    expect(result.kind).toBe("ask");
    if (result.kind === "ask") {
      expect(result.matchedPattern).toBe("bash");
    }
  });

  test("step 6: default deny when no rule matches", () => {
    const result = evaluateToolRequest("unknown", {}, makeConfig());
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("default deny");
    }
  });

  // ── Priority tests ──────────────────────────────────────────────────

  test("base deny overrides session allow (step 1 > step 3)", () => {
    const result = evaluateToolRequest(
      "bash",
      {},
      makeConfig({ baseDeny: ["bash"], sessionAllow: ["bash"] }),
    );
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("denied by policy");
    }
  });

  test("base deny overrides base allow (step 1 > step 4)", () => {
    const result = evaluateToolRequest(
      "bash",
      {},
      makeConfig({ baseDeny: ["bash"], baseAllow: ["bash"] }),
    );
    expect(result.kind).toBe("deny");
  });

  test("base deny overrides base ask (step 1 > step 5)", () => {
    const result = evaluateToolRequest(
      "bash",
      {},
      makeConfig({ baseDeny: ["bash"], baseAsk: ["bash"] }),
    );
    expect(result.kind).toBe("deny");
  });

  test("session deny overrides session allow (step 2 > step 3)", () => {
    const result = evaluateToolRequest(
      "bash",
      {},
      makeConfig({ sessionDeny: ["bash"], sessionAllow: ["bash"] }),
    );
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("session policy");
    }
  });

  test("session allow overrides base allow (step 3 > step 4)", () => {
    // Both would return allow, but session allow matches first
    const result = evaluateToolRequest(
      "bash",
      {},
      makeConfig({ sessionAllow: ["bash"], baseAllow: ["bash"] }),
    );
    expect(result.kind).toBe("allow");
  });

  test("session allow overrides base ask (step 3 > step 5)", () => {
    const result = evaluateToolRequest(
      "bash",
      {},
      makeConfig({ sessionAllow: ["bash"], baseAsk: ["bash"] }),
    );
    expect(result.kind).toBe("allow");
  });

  test("base allow overrides base ask (step 4 > step 5)", () => {
    const result = evaluateToolRequest(
      "bash",
      {},
      makeConfig({ baseAllow: ["bash"], baseAsk: ["bash"] }),
    );
    expect(result.kind).toBe("allow");
  });

  // ── Compound pattern tests ──────────────────────────────────────────

  test("compound deny pattern matches tool + command", () => {
    const result = evaluateToolRequest(
      "bash",
      { command: "rm -rf /" },
      makeConfig({ baseDeny: ["bash:rm*"] }),
    );
    expect(result.kind).toBe("deny");
  });

  test("compound allow pattern matches tool + command", () => {
    const result = evaluateToolRequest(
      "bash",
      { command: "ls -la" },
      makeConfig({ baseAllow: ["bash:ls*"] }),
    );
    expect(result.kind).toBe("allow");
  });

  test("compound ask pattern returns matched pattern string", () => {
    const result = evaluateToolRequest(
      "bash",
      { command: "git push origin" },
      makeConfig({ baseAsk: ["bash:git push*"] }),
    );
    expect(result.kind).toBe("ask");
    if (result.kind === "ask") {
      expect(result.matchedPattern).toBe("bash:git push*");
    }
  });

  test("compound pattern does not match different tool", () => {
    const result = evaluateToolRequest(
      "python",
      { command: "ls -la" },
      makeConfig({ baseAllow: ["bash:ls*"] }),
    );
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("default deny");
    }
  });

  // ── Wildcard tests ──────────────────────────────────────────────────

  test("wildcard '*' in allow matches any tool", () => {
    const result = evaluateToolRequest("anything", {}, makeConfig({ baseAllow: ["*"] }));
    expect(result.kind).toBe("allow");
  });

  test("wildcard '*' in deny matches any tool", () => {
    const result = evaluateToolRequest("anything", {}, makeConfig({ baseDeny: ["*"] }));
    expect(result.kind).toBe("deny");
  });

  // ── Empty arrays ────────────────────────────────────────────────────

  test("empty config with empty arrays returns default deny", () => {
    const result = evaluateToolRequest("bash", {}, makeConfig());
    expect(result.kind).toBe("deny");
  });

  // ── Custom extractCommand ────────────────────────────────────────────

  test("uses custom extractCommand for compound matching", () => {
    const result = evaluateToolRequest(
      "bash",
      { script: "deploy.sh" },
      makeConfig({
        baseAsk: ["bash:deploy*"],
        extractCommand: (input) => (typeof input.script === "string" ? input.script : ""),
      }),
    );
    expect(result.kind).toBe("ask");
    if (result.kind === "ask") {
      expect(result.matchedPattern).toBe("bash:deploy*");
    }
  });
});
