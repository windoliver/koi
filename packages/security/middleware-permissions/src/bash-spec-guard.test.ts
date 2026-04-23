import { beforeAll, describe, expect, test } from "bun:test";
import { createSpecRegistry, initializeBashAst, MAX_COMMAND_LENGTH } from "@koi/bash-ast";
import type { PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";
import { evaluateSpecGuard } from "./bash-spec-guard.js";

const allowDecision: PermissionDecision = { effect: "allow" };
const hardDeny = (reason: string): PermissionDecision => ({
  effect: "deny",
  reason,
  disposition: "hard",
});

const baseQuery: PermissionQuery = {
  resource: "bash:rm",
  action: "invoke",
  principal: "agent:test",
};

const registry = createSpecRegistry();

beforeAll(async () => {
  await initializeBashAst();
});

// --- refused spec ---

describe("evaluateSpecGuard — refused spec enforces exact-argv guard", () => {
  test("refused spec (ssh) + prefix allow → downgrade to ask", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "ssh prod-host",
      currentDecision: allowDecision,
      resolveQuery: async (_q) => allowDecision,
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("ask");
    expect(result.specKind).toBe("refused");
  });

  test("refused spec + existing deny → keep deny (guard never weakens)", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "ssh prod-host",
      currentDecision: hardDeny("policy deny"),
      resolveQuery: async (_q) => allowDecision,
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("deny");
  });

  test("refused spec + exact-argv allow rule → honor explicit exact rule", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "ssh prod-host",
      currentDecision: allowDecision,
      resolveQuery: async (q) =>
        q.resource === "bash:ssh prod-host" ? allowDecision : hardDeny("no rule"),
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("allow");
    expect(result.specKind).toBe("refused");
  });
});

// --- partial spec ---

describe("evaluateSpecGuard — partial spec enforces exact-argv guard", () => {
  test("rm -r (partial/recursive) + prefix allow → downgrade to ask", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "rm -r /tmp/work",
      currentDecision: allowDecision,
      resolveQuery: async (_q) => allowDecision,
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("ask");
    expect(result.specKind).toBe("partial");
  });

  test("rm -r + exact-argv rule + Write allow → allow (with backendSupportsDualKey)", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "rm -r /tmp/work",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        if (q.resource === "bash:rm -r /tmp/work") return allowDecision;
        if (q.action === "write") return allowDecision;
        return hardDeny("no rule");
      },
      baseQuery,
      registry,
      backendSupportsDualKey: true,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("allow");
  });
});

// --- complete spec ---

describe("evaluateSpecGuard — complete spec evaluates semantic rules (backendSupportsDualKey)", () => {
  test("rm /etc/passwd → Write deny on /etc/** triggers deny", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "rm /etc/passwd",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        if (q.action === "write" && q.resource.startsWith("/etc/"))
          return hardDeny("writes to /etc denied");
        return allowDecision;
      },
      baseQuery,
      registry,
      backendSupportsDualKey: true,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("deny");
    expect(result.specKind).toBe("complete");
  });

  test("curl https://example.com/path → Network rule matches by host not URL", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "curl https://example.com/path",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        // Must match on host "example.com", not full URL
        if (q.action === "network" && q.resource === "example.com")
          return hardDeny("network to example.com denied");
        return allowDecision;
      },
      baseQuery,
      registry,
      backendSupportsDualKey: true,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("deny");
  });

  test("curl https://example.com:8443/path → host is example.com:8443", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "curl https://example.com:8443/path",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        if (q.action === "network" && q.resource === "example.com:8443") return hardDeny("denied");
        return allowDecision;
      },
      baseQuery,
      registry,
      backendSupportsDualKey: true,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("deny");
  });

  test("rm /tmp/safe + allow-all backend → allow passes through", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "rm /tmp/safe",
      currentDecision: allowDecision,
      resolveQuery: async (_q) => allowDecision,
      baseQuery,
      registry,
      backendSupportsDualKey: true,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("allow");
    expect(result.specKind).toBe("complete");
  });

  test("semantic rules skipped without backendSupportsDualKey (legacy backend compat)", async () => {
    // Without backendSupportsDualKey, semantic Write/Network rules must NOT be
    // enforced — the backend can't distinguish matched rules from fall-through
    // denies, so we'd incorrectly downgrade commands that have no semantic rule.
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "rm /etc/passwd",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        if (q.action === "write") return hardDeny("no Write rule matched");
        return allowDecision;
      },
      baseQuery,
      registry,
      // backendSupportsDualKey intentionally omitted
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    // Without dual-key backend, semantic deny must NOT apply
    expect(result.decision.effect).toBe("allow");
  });
});

// --- too-complex / parse-unavailable ---

describe("evaluateSpecGuard — complex commands ratchet allow → ask", () => {
  test("pipeline (too-complex) with current allow → downgrade to ask", async () => {
    // Operators may explicitly allow `bash:!complex*` for automation — but we
    // cannot verify semantics for complex forms, so ratchet to ask for review.
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "cat /etc/passwd | grep root",
      currentDecision: allowDecision,
      resolveQuery: async (_q) => allowDecision,
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("ask");
  });

  test("pipeline (too-complex) with current ask/deny → unchanged (skipped)", async () => {
    // Already non-allow → no further downgrade needed
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "cat /etc/passwd | grep root",
      currentDecision: { effect: "ask" },
      resolveQuery: async (_q) => hardDeny("should not be called"),
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("skipped");
  });
});

describe("evaluateSpecGuard — parse-unavailable fails closed", () => {
  test("over-length command → parse-unavailable → deny (fail-closed)", async () => {
    // Commands exceeding MAX_COMMAND_LENGTH return parse-unavailable(over-length).
    // The spec guard MUST deny — callers must fail closed per bash-ast contract.
    const overLength = `echo ${"x".repeat(MAX_COMMAND_LENGTH)}`;
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: overLength,
      currentDecision: allowDecision,
      resolveQuery: async (_q) => allowDecision,
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("deny");
    expect(result.decision.reason).toContain("over-length");
  });
});

describe("evaluateSpecGuard — exact-argv detection with canary suffix", () => {
  test("broad wildcard (bash:*) + exact also allows → downgrade to ask (canary detects wildcard)", async () => {
    // Scenario: user has `allow: bash:*`. Both exact AND canary allow → prefix/wildcard.
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "ssh prod-host",
      currentDecision: allowDecision,
      resolveQuery: async (_q) => allowDecision,
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("ask");
    expect(result.specKind).toBe("refused");
  });

  test("prefix rule (bash:ssh*) + exact allows → downgrade to ask (canary detects prefix)", async () => {
    // Scenario: user has `allow: bash:ssh*`. Exact allows; canary `bash:ssh prod-host\x01...`
    // also allows (glob `[^/]*` matches the canary suffix) → prefix rule → downgrade to ask.
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "ssh prod-host",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        // Simulate `bash:ssh*` — matches anything starting with `bash:ssh`
        if (q.resource.startsWith("bash:ssh")) return allowDecision;
        return hardDeny("no rule");
      },
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    // Canary starts with `bash:ssh` → prefix rule matches → downgrade to ask
    expect(result.decision.effect).toBe("ask");
    expect(result.specKind).toBe("refused");
  });

  test("exact rule only (bash:ssh prod-host) → honor explicit rule", async () => {
    // Scenario: user has ONLY `allow: bash:ssh prod-host` (no wildcard or prefix).
    // Canary suffix makes the resource not match the exact pattern → canary denies → explicit.
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "ssh prod-host",
      currentDecision: allowDecision,
      resolveQuery: async (q) =>
        q.resource === "bash:ssh prod-host" ? allowDecision : hardDeny("no rule"),
      baseQuery,
      registry,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("allow");
    expect(result.specKind).toBe("refused");
  });
});

describe("evaluateSpecGuard — path-qualified binaries (#1919 regression)", () => {
  test("/bin/rm /etc/passwd → resolves to complete spec + Write deny applies", async () => {
    // Without verifiedBaseName, /bin/rm would return refused spec (no semantic check).
    // With the fix, basename "rm" is extracted and the complete spec fires Write rules.
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "/bin/rm /etc/passwd",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        if (q.action === "write" && q.resource.startsWith("/etc/"))
          return hardDeny("writes to /etc denied");
        return allowDecision;
      },
      baseQuery,
      registry,
      backendSupportsDualKey: true,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("deny");
    expect(result.specKind).toBe("complete");
  });

  test("/usr/bin/curl https://evil.com → Network deny applies via verifiedBaseName", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "/usr/bin/curl https://evil.com/path",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        if (q.action === "network" && q.resource === "evil.com") return hardDeny("blocked");
        return allowDecision;
      },
      baseQuery,
      registry,
      backendSupportsDualKey: true,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("deny");
  });
});

describe("evaluateSpecGuard — public default-deny field detection (#1919 regression)", () => {
  test("backend with default:true field skips Write rule (not explicit deny)", async () => {
    // Custom backends may mark fall-throughs via `default: true` instead of IS_DEFAULT_DENY symbol.
    // The spec guard must treat these as fall-throughs, not explicit rules.
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "rm /tmp/safe",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        if (q.action === "write") {
          // Simulate a backend that marks fall-throughs with public `default: true`
          return {
            effect: "deny",
            reason: "no rule matched",
            default: true,
          } as PermissionDecision & { default: boolean };
        }
        return allowDecision;
      },
      baseQuery,
      registry,
      backendSupportsDualKey: true,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    // Fall-through default deny must NOT downgrade an allow
    expect(result.decision.effect).toBe("allow");
  });

  test("backend with defaultDeny:true field skips Write rule (not explicit deny)", async () => {
    const result = await evaluateSpecGuard({
      toolId: "bash",
      rawCommand: "rm /tmp/safe",
      currentDecision: allowDecision,
      resolveQuery: async (q) => {
        if (q.action === "write") {
          return {
            effect: "deny",
            reason: "fallthrough",
            defaultDeny: true,
          } as PermissionDecision & { defaultDeny: boolean };
        }
        return allowDecision;
      },
      baseQuery,
      registry,
      backendSupportsDualKey: true,
    });
    expect(result.kind).toBe("spec-evaluated");
    if (result.kind !== "spec-evaluated") return;
    expect(result.decision.effect).toBe("allow");
  });
});
