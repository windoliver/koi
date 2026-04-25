import { describe, expect, test } from "bun:test";
import type { DelegationScope } from "@koi/core";
import { sessionId } from "@koi/core";
import { createGlobScopeChecker } from "./scope-checker.js";

const mkScope = (allow: readonly string[], deny: readonly string[] = []): DelegationScope => ({
  permissions: { allow, deny },
  sessionId: sessionId("sess-1"),
});

describe("createGlobScopeChecker", () => {
  const check = createGlobScopeChecker();

  test("exact-match allow returns true", async () => {
    expect(await check.isAllowed("read_file", mkScope(["read_file"]))).toBe(true);
  });

  test("missing from allow returns false", async () => {
    expect(await check.isAllowed("write_file", mkScope(["read_file"]))).toBe(false);
  });

  test("wildcard '*' in allow returns true for any tool", async () => {
    expect(await check.isAllowed("anything", mkScope(["*"]))).toBe(true);
  });

  test("deny wins over allow", async () => {
    expect(await check.isAllowed("bash", mkScope(["*"], ["bash"]))).toBe(false);
    expect(await check.isAllowed("bash", mkScope(["bash"], ["bash"]))).toBe(false);
  });

  test("empty allow returns false even with wildcard deny", async () => {
    expect(await check.isAllowed("anything", mkScope([], []))).toBe(false);
  });

  test("undefined allow/deny treats as empty", async () => {
    const scope: DelegationScope = {
      permissions: {},
      sessionId: sessionId("sess-1"),
    };
    expect(await check.isAllowed("read_file", scope)).toBe(false);
  });

  test("prefix glob 'db:*' in allow matches db:delete (codex round-4: high)", async () => {
    expect(await check.isAllowed("db:delete", mkScope(["db:*"]))).toBe(true);
    expect(await check.isAllowed("fs:read", mkScope(["db:*"]))).toBe(false);
  });

  test("prefix glob 'db:*' in deny blocks db:delete even when allow=['*'] (codex round-4: high)", async () => {
    expect(await check.isAllowed("db:delete", mkScope(["*"], ["db:*"]))).toBe(false);
    // Non-matching tool with allow:* and deny:db:* still allowed.
    expect(await check.isAllowed("fs:read", mkScope(["*"], ["db:*"]))).toBe(true);
  });

  test("wildcard deny '*' blocks every tool (codex round-4: high)", async () => {
    expect(await check.isAllowed("anything", mkScope(["*"], ["*"]))).toBe(false);
  });

  test("ask without interactive checker fails closed (codex round-4: critical)", async () => {
    // Ask requires human approval. Default checker has no approval
    // mechanism, so a token whose ask pattern matches the requested
    // toolId must be denied — production deployments needing
    // ask-and-approve flows must inject an interactive scope checker.
    const askScope: DelegationScope = {
      permissions: { allow: ["*"], ask: ["bash"] },
      sessionId: sessionId("sess-1"),
    };
    expect(await check.isAllowed("bash", askScope)).toBe(false);
    // Glob ask still applies.
    const askGlob: DelegationScope = {
      permissions: { allow: ["*"], ask: ["db:*"] },
      sessionId: sessionId("sess-1"),
    };
    expect(await check.isAllowed("db:delete", askGlob)).toBe(false);
    // Non-matching ask leaves allow path free.
    expect(await check.isAllowed("read_file", askScope)).toBe(true);
  });

  test("resource-scoped tokens fail closed (codex round-2: high)", async () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file"] },
      resources: ["read_file:/safe/**"],
      sessionId: sessionId("sess-1"),
    };
    expect(await check.isAllowed("read_file", scope)).toBe(false);
  });
});
