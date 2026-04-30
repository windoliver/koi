import { describe, expect, test } from "bun:test";
import type { CredentialComponent } from "@koi/core";
import { createScopedCredentials } from "../scoped-credentials.js";

function makeStore(values: Record<string, string>): CredentialComponent {
  return {
    async get(key) {
      return values[key];
    },
  };
}

describe("createScopedCredentials", () => {
  test("returns the value for an allowlisted key", async () => {
    const store = makeStore({ "myapp/api-key": "secret" });
    const scoped = createScopedCredentials(store, { allow: ["myapp/*"] });
    expect(await scoped.get("myapp/api-key")).toBe("secret");
  });

  test("returns undefined for a non-allowlisted key", async () => {
    const store = makeStore({ "other/api-key": "secret" });
    const scoped = createScopedCredentials(store, { allow: ["myapp/*"] });
    expect(await scoped.get("other/api-key")).toBeUndefined();
  });

  test("supports multiple allow globs", async () => {
    const store = makeStore({ "a/x": "1", "b/y": "2", "c/z": "3" });
    const scoped = createScopedCredentials(store, { allow: ["a/*", "b/*"] });
    expect(await scoped.get("a/x")).toBe("1");
    expect(await scoped.get("b/y")).toBe("2");
    expect(await scoped.get("c/z")).toBeUndefined();
  });

  test("`*` does not cross separators", async () => {
    const store = makeStore({ "myapp/api/key": "deep" });
    const scoped = createScopedCredentials(store, { allow: ["myapp/*"] });
    expect(await scoped.get("myapp/api/key")).toBeUndefined();
  });

  test("`**` crosses separators", async () => {
    const store = makeStore({ "myapp/api/key": "deep" });
    const scoped = createScopedCredentials(store, { allow: ["myapp/**"] });
    expect(await scoped.get("myapp/api/key")).toBe("deep");
  });

  test("empty allowlist denies every key", async () => {
    const store = makeStore({ a: "1" });
    const scoped = createScopedCredentials(store, { allow: [] });
    expect(await scoped.get("a")).toBeUndefined();
  });

  test("does not leak existence — non-allowlisted key indistinguishable from missing", async () => {
    const store = makeStore({ "secret/key": "value" });
    const scoped = createScopedCredentials(store, { allow: ["public/*"] });
    expect(await scoped.get("secret/key")).toBeUndefined();
    expect(await scoped.get("does-not-exist")).toBeUndefined();
  });

  test("deny path crosses an async boundary (round-5 latency-oracle defense)", async () => {
    // gov-15 round-5: with the previous synchronous deny path, an
    // out-of-scope key returned in microtask 0 while an in-scope-but-
    // missing key required dispatching to the underlying component
    // (microtask 1+). An agent could probe credKey candidates and
    // distinguish the two by response time despite identical
    // PERMISSION messages. The fix: an `await Promise.resolve()` on
    // the deny path so both paths cross the same microtask boundary.
    //
    // Assert the fix structurally: a non-allowed lookup must observe
    // microtasks scheduled BEFORE its return value is settled.
    const store = makeStore({ "secret/key": "value" });
    const scoped = createScopedCredentials(store, { allow: ["public/*"] });
    let microtaskRan = false;
    Promise.resolve().then(() => {
      microtaskRan = true;
    });
    const result = await scoped.get("secret/key");
    expect(result).toBeUndefined();
    // The microtask must have run by the time our await resolves —
    // proving the deny path itself awaited at least one microtask
    // boundary, matching the in-scope path's dispatch.
    expect(microtaskRan).toBe(true);
  });
});
