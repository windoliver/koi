import { describe, expect, test } from "bun:test";

import type { Playbook } from "@koi/ace-types";
import type { KoiError, Result } from "@koi/core";
import type { NexusTransport as FsNexusTransport } from "@koi/fs-nexus";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";

import { createNexusPlaybookStore } from "../playbook.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pb(id: string, confidence = 0.5, tags: readonly string[] = []): Playbook {
  return {
    id,
    title: "t",
    strategy: "s",
    tags,
    confidence,
    source: "curated",
    createdAt: 0,
    updatedAt: 0,
    sessionCount: 1,
    version: 1,
  };
}

function newStore() {
  return createNexusPlaybookStore({ transport: createFakeNexusTransport() });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusPlaybookStore", () => {
  test("save → get round-trip", async () => {
    const store = newStore();
    await store.save(pb("a"));
    const got = await store.get("a");
    expect(got?.id).toBe("a");
    expect(got?.confidence).toBe(0.5);
  });

  test("missing returns undefined", async () => {
    const store = newStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  test("list filters by minConfidence", async () => {
    const store = newStore();
    await store.save(pb("lo", 0.1));
    await store.save(pb("hi", 0.9));
    await store.save(pb("mid", 0.5));
    const high = await store.list({ minConfidence: 0.5 });
    expect(high.map((p) => p.id).sort()).toEqual(["hi", "mid"]);
  });

  test("list filters by tag", async () => {
    const store = newStore();
    await store.save(pb("a", 0.5, ["x", "y"]));
    await store.save(pb("b", 0.5, ["z"]));
    await store.save(pb("c", 0.5, ["x"]));
    const tagged = await store.list({ tags: ["y"] });
    expect(tagged.map((p) => p.id).sort()).toEqual(["a"]);
  });

  test("remove deletes", async () => {
    const store = newStore();
    await store.save(pb("r"));
    expect(await store.remove("r")).toBe(true);
    expect(await store.get("r")).toBeUndefined();
  });

  test("remove of missing returns false", async () => {
    const store = newStore();
    expect(await store.remove("nope")).toBe(false);
  });

  // --- contract parity tests (ported from sqlite sibling) ---

  test("list filters by tags AND minConfidence together (intersection)", async () => {
    // Mirrors sqlite "filters list by minConfidence and tags".
    // Verifies that tags uses AND semantics (ALL requested tags must be present)
    // and that minConfidence + tags filters compose correctly.
    const store = newStore();
    await store.save(pb("lo", 0.1, ["x"]));
    await store.save(pb("hi", 0.9, ["x", "y"]));
    await store.save(pb("mid", 0.5, ["z"]));

    // minConfidence=0.5 → "hi" and "mid" (not "lo" at 0.1)
    const high = await store.list({ minConfidence: 0.5 });
    expect(high.map((p) => p.id).sort()).toEqual(["hi", "mid"]);

    // tags=["x","y"] with AND semantics → only "hi" (has both x and y; "lo" has only x)
    const tagged = await store.list({ tags: ["x", "y"] });
    expect(tagged.map((p) => p.id)).toEqual(["hi"]);
  });

  test("save overwrites existing playbook (last-write-wins)", async () => {
    // Nexus is last-write-wins; sqlite uses version-CAS. Divergence is documented.
    const store = newStore();
    await store.save(pb("p", 0.5));
    await store.save({ ...pb("p", 0.9), title: "updated" });
    const got = await store.get("p");
    expect(got?.confidence).toBe(0.9);
    expect(got?.title).toBe("updated");
  });

  // --- ACE ID path-safety regression tests (Finding 1) ---

  test("save with id containing '/' is rejected with validation error", async () => {
    const store = newStore();
    await expect(store.save(pb("a/b"))).rejects.toThrow("Playbook ID cannot contain '/'");
  });

  test("save with id containing '..' is rejected with validation error", async () => {
    const store = newStore();
    await expect(store.save(pb("a..b"))).rejects.toThrow("Playbook ID");
  });

  test("save with id containing backslash is rejected", async () => {
    const store = newStore();
    await expect(store.save(pb("a\\b"))).rejects.toThrow("Playbook ID");
  });

  test("save with id containing null byte is rejected", async () => {
    const store = newStore();
    await expect(store.save(pb("a\0b"))).rejects.toThrow("Playbook ID");
  });

  test("save 'a:b' and 'a_b' produce distinct files — no collision", async () => {
    const store = newStore();
    await store.save(pb("a:b", 0.1));
    await store.save(pb("a_b", 0.9));
    // Both must be independently retrievable
    expect((await store.get("a:b"))?.confidence).toBe(0.1);
    expect((await store.get("a_b"))?.confidence).toBe(0.9);
    // list must return both
    const all = await store.list();
    expect(all.map((p) => p.id).sort()).toEqual(["a:b", "a_b"]);
  });

  // --- Fix 5 (round 5): list propagates non-NOT_FOUND errors ---

  test("list propagates EXTERNAL error from mid-list file read", async () => {
    // Scenario: one playbook is written normally. Then a transport wrapper injects
    // EXTERNAL on the read of that file during list(). The method must throw.
    const baseTransport = createFakeNexusTransport();
    const baseStore = createNexusPlaybookStore({ transport: baseTransport });
    await baseStore.save(pb("pb-list-err"));

    let listCallDone = false;
    const wrappedTransport: FsNexusTransport = {
      call: async <T>(
        method: string,
        params: Record<string, unknown>,
      ): Promise<Result<T, KoiError>> => {
        const path = params.path as string | undefined;
        if (
          listCallDone &&
          method === "read" &&
          typeof path === "string" &&
          path.includes("/playbooks/")
        ) {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "simulated backend failure", retryable: true },
          } as Result<T, KoiError>;
        }
        if (method === "list") listCallDone = true;
        return baseTransport.call<T>(method, params);
      },
      subscribe: baseTransport.subscribe.bind(baseTransport),
      submitAuthCode: baseTransport.submitAuthCode.bind(baseTransport),
      close: baseTransport.close.bind(baseTransport),
    };

    const wrappedStore = createNexusPlaybookStore({ transport: wrappedTransport });
    await expect(wrappedStore.list()).rejects.toThrow("simulated backend failure");
  });
});
