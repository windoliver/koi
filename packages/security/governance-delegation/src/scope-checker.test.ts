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
});
