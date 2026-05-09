import { describe, expect, test } from "bun:test";

import type { PlaybookProposal, StructuredPlaybook, TrajectoryRange } from "@koi/ace-types";
import type { KoiError, Result } from "@koi/core";
import type { NexusTransport as FsNexusTransport } from "@koi/fs-nexus";
import { createFakeNexusTransport } from "@koi/fs-nexus/testing";

import { createNexusPlaybookProposalStore } from "../proposal.js";
import { createNexusStructuredPlaybookStore } from "../structured.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function spb(id: string, tags: readonly string[] = []): StructuredPlaybook {
  return {
    id,
    title: "t",
    sections: [
      {
        name: "Errors",
        slug: "errors",
        bullets: [
          {
            id: "b1",
            content: "always check existence",
            helpful: 1,
            harmful: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      },
    ],
    tags,
    source: "curated",
    createdAt: 0,
    updatedAt: 0,
    sessionCount: 1,
    version: 1,
  };
}

function newStore() {
  return createNexusStructuredPlaybookStore({
    transport: createFakeNexusTransport(),
    requirePreProvisioned: false,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusStructuredPlaybookStore", () => {
  test("save → get round-trip", async () => {
    const store = newStore();
    await store.save(spb("a"));
    const got = await store.get("a");
    expect(got?.id).toBe("a");
    expect(got?.sections[0]?.slug).toBe("errors");
  });

  test("missing returns undefined", async () => {
    const store = newStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  test("list filters by tag", async () => {
    const store = newStore();
    await store.save(spb("a", ["x", "y"]));
    await store.save(spb("b", ["z"]));
    await store.save(spb("c", ["x"]));
    const tagged = await store.list({ tags: ["y"] });
    expect(tagged.map((p) => p.id).sort()).toEqual(["a"]);
  });

  test("remove deletes", async () => {
    const store = newStore();
    await store.save(spb("r"));
    expect(await store.remove("r")).toBe(true);
    expect(await store.get("r")).toBeUndefined();
  });

  test("remove of missing returns false", async () => {
    const store = newStore();
    expect(await store.remove("nope")).toBe(false);
  });

  test("getVersion returns undefined (lineage not stored)", async () => {
    const store = newStore();
    await store.save(spb("v"));
    expect(await store.getVersion?.("v", 1)).toBeUndefined();
  });

  // --- contract parity tests (ported from sqlite sibling) ---

  test("list filters by multiple tags with AND semantics", async () => {
    // Verifies that when multiple tags are requested, ALL must match (AND),
    // not just any one of them (OR). Mirrors sqlite filterByTags behaviour.
    const store = newStore();
    await store.save(spb("one-tag", ["x"]));
    await store.save(spb("two-tags", ["x", "y"]));
    await store.save(spb("other", ["z"]));

    // tags=["x","y"] → only "two-tags" has both; "one-tag" has only "x"
    const filtered = await store.list({ tags: ["x", "y"] });
    expect(filtered.map((p) => p.id)).toEqual(["two-tags"]);
  });

  test("save with same id rejects below-head writes (monotonic version CAS)", async () => {
    // Since #1715 the Nexus structured store enforces the same monotonic
    // version contract as sqlite: forward writes succeed; below-head replays
    // and same-version divergent content are rejected. Cross-process safety
    // is enforced by transport-level if_match etag CAS. Documented in
    // docs/L2/playbook-store-nexus.md.
    const store = newStore();
    await store.save({ ...spb("p"), version: 2, title: "v2" });
    await store.save({ ...spb("p"), version: 3, title: "v3" });
    expect((await store.get("p"))?.version).toBe(3);
    expect((await store.get("p"))?.title).toBe("v3");
    // Out-of-order: re-saving v2 after v3 must fail closed.
    await expect(store.save({ ...spb("p"), version: 2, title: "rollback" })).rejects.toThrow(
      /below current version/i,
    );
    expect((await store.get("p"))?.version).toBe(3);
  });

  test("top-level etag envelope (no metadata wrapper) is accepted for CAS", async () => {
    // Some Nexus transport versions surface etag at the top level of the
    // read envelope (not nested under `metadata`). The structured store
    // must extract the etag from either location to remain compatible.
    const baseTransport = createFakeNexusTransport();
    const seed = createNexusStructuredPlaybookStore({
      transport: baseTransport,
      requirePreProvisioned: false,
    });
    await seed.save(spb("topetag"));

    const topLevelTransport: FsNexusTransport = {
      call: async <T>(
        method: string,
        params: Record<string, unknown>,
      ): Promise<Result<T, KoiError>> => {
        const r = await baseTransport.call<T>(method, params);
        if (
          r.ok &&
          method === "read" &&
          typeof params.path === "string" &&
          params.path.includes("/structured/")
        ) {
          const v = r.value as { content?: unknown; metadata?: { etag?: string } } | undefined;
          if (v !== undefined) {
            // Move etag from metadata.etag to top-level etag.
            return {
              ok: true,
              value: { content: v.content, etag: v.metadata?.etag } as T,
            };
          }
        }
        return r;
      },
      subscribe: baseTransport.subscribe.bind(baseTransport),
      submitAuthCode: baseTransport.submitAuthCode.bind(baseTransport),
      close: baseTransport.close.bind(baseTransport),
    };
    const topLevelStore = createNexusStructuredPlaybookStore({
      transport: topLevelTransport,
      requirePreProvisioned: false,
    });
    await expect(
      topLevelStore.save({ ...spb("topetag"), version: 2, title: "v2" }),
    ).resolves.toBeUndefined();
  });

  test("missing etag on read of existing head fails closed (no blind overwrite)", async () => {
    // A degraded transport that returns content but strips metadata.etag —
    // simulates a backend version skew or a buggy transport wrapper. The
    // structured store MUST refuse to overwrite, otherwise two coordinators
    // racing on the same head would both succeed and one update is silently
    // lost (the bug this CAS path exists to prevent).
    const baseTransport = createFakeNexusTransport();
    const seed = createNexusStructuredPlaybookStore({
      transport: baseTransport,
      requirePreProvisioned: false,
    });
    await seed.save(spb("noetag"));

    const noEtagTransport: FsNexusTransport = {
      call: async <T>(
        method: string,
        params: Record<string, unknown>,
      ): Promise<Result<T, KoiError>> => {
        const r = await baseTransport.call<T>(method, params);
        if (
          r.ok &&
          method === "read" &&
          typeof params.path === "string" &&
          params.path.includes("/structured/")
        ) {
          // Strip metadata so etag is undefined.
          const v = r.value as { content?: unknown } | undefined;
          if (v !== undefined) {
            return { ok: true, value: { content: v.content } as T };
          }
        }
        return r;
      },
      subscribe: baseTransport.subscribe.bind(baseTransport),
      submitAuthCode: baseTransport.submitAuthCode.bind(baseTransport),
      close: baseTransport.close.bind(baseTransport),
    };
    const noEtagStore = createNexusStructuredPlaybookStore({
      transport: noEtagTransport,
      requirePreProvisioned: false,
    });
    await expect(noEtagStore.save({ ...spb("noetag"), version: 2, title: "v2" })).rejects.toThrow(
      /no etag|refusing blind overwrite/i,
    );
  });

  // --- ACE ID path-safety regression tests (Finding 1) ---

  test("save with id containing '/' is rejected with validation error", async () => {
    const store = newStore();
    await expect(store.save(spb("a/b"))).rejects.toThrow("Structured Playbook ID");
  });

  test("save with id containing '..' is rejected", async () => {
    const store = newStore();
    await expect(store.save(spb("a..b"))).rejects.toThrow("Structured Playbook ID");
  });

  test("save 'a:b' and 'a_b' produce distinct files — no collision", async () => {
    const store = newStore();
    await store.save({ ...spb("a:b"), version: 1 });
    await store.save({ ...spb("a_b"), version: 2 });
    expect((await store.get("a:b"))?.version).toBe(1);
    expect((await store.get("a_b"))?.version).toBe(2);
    const all = await store.list();
    expect(all.map((p) => p.id).sort()).toEqual(["a:b", "a_b"]);
  });

  // --- Fix 5 (round 5): list propagates non-NOT_FOUND errors ---

  test("list propagates EXTERNAL error from mid-list file read", async () => {
    // Scenario: one structured playbook is written normally. Then a transport
    // wrapper injects EXTERNAL on the read of that file during list(). Must throw.
    const baseTransport = createFakeNexusTransport();
    const baseStore = createNexusStructuredPlaybookStore({
      transport: baseTransport,
      requirePreProvisioned: false,
    });
    await baseStore.save(spb("spb-list-err"));

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
          path.includes("/structured/")
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

    const wrappedStore = createNexusStructuredPlaybookStore({
      transport: wrappedTransport,
      requirePreProvisioned: false,
    });
    await expect(wrappedStore.list()).rejects.toThrow("simulated backend failure");
  });

  // --- Fix 1 (round 9): lockScope-keyed registry — wrapper-transport race tests ---

  test("wrapper-transport: structured.save + recordProposal from wrapper stores with same lockScope serialize", async () => {
    // Two stores (one structured, one proposal) over wrapper transports of the
    // SAME backend, SAME lockScope. Concurrent save(v=2) + recordProposal(baseVersion=1)
    // must serialize through the shared playbook lock — same invariant as the
    // single-transport concurrent test in proposal.test.ts but verified here with
    // wrapper transports to confirm the lockScope fix propagates correctly.
    const trajRange: TrajectoryRange = { sessionId: "s1", fromStepIndex: 0, toStepIndex: 1 };
    function makeProposal(id: string, playbookId: string, baseVersion: number): PlaybookProposal {
      return {
        id,
        playbookId,
        baseVersion,
        operations: [{ kind: "add", section: "errors", content: "check first" }],
        sourceTrajectoryRange: trajRange,
        reflection: {
          rootCause: "missed precondition",
          keyInsight: "verify state first",
          bulletTags: [{ id: "b1", tag: "helpful" }],
        },
        createdAt: 100,
      };
    }

    const baseTransport = createFakeNexusTransport();

    function wrapTransport(t: typeof baseTransport): typeof baseTransport {
      return {
        call: (m, p, opts) => t.call(m, p, opts),
        subscribe: t.subscribe.bind(t),
        submitAuthCode: t.submitAuthCode.bind(t),
        close: () => t.close(),
      };
    }

    const structuredStore = createNexusStructuredPlaybookStore({
      transport: wrapTransport(baseTransport),
      lockScope: "shared-structured-backend",
      requirePreProvisioned: false,
    });
    const proposalStore = createNexusPlaybookProposalStore({
      transport: wrapTransport(baseTransport),
      lockScope: "shared-structured-backend",
    });

    // Bootstrap: save v1 so recordProposal has a starting point.
    await structuredStore.save({ ...spb("pb-wrapper-lock"), version: 1 });

    // Race: bump to v2 while simultaneously recording a proposal against v1.
    const [saveResult, recordResult] = await Promise.allSettled([
      structuredStore.save({ ...spb("pb-wrapper-lock"), version: 2 }),
      proposalStore.recordProposal(makeProposal("p-wrapper-lock", "pb-wrapper-lock", 1)),
    ]);

    // save advances monotonically (v1 -> v2) — must always succeed.
    expect(saveResult.status).toBe("fulfilled");

    if (recordResult.status === "rejected") {
      // Proposal lost the lock (save ran first, bumped to v=2, proposal saw v=2).
      expect(String(recordResult.reason)).toContain("version");
    } else {
      // Proposal won the lock (read v=1, wrote proposal, save ran after).
      const got = await proposalStore.getProposal("p-wrapper-lock");
      expect(got?.baseVersion).toBe(1);
    }
  });

  test("default config allows initial create on empty backend (bootstrap path)", async () => {
    const transport = createFakeNexusTransport();
    try {
      // No requirePreProvisioned — default must permit first save.
      const store = createNexusStructuredPlaybookStore({ transport });
      await store.save({ ...spb("pb-bootstrap"), version: 1 });
      const got = await store.get("pb-bootstrap");
      expect(got?.version).toBe(1);
    } finally {
      transport.close();
    }
  });

  test("requirePreProvisioned: true rejects initial create on empty backend (opt-in fail-closed)", async () => {
    const transport = createFakeNexusTransport();
    try {
      const store = createNexusStructuredPlaybookStore({
        transport,
        requirePreProvisioned: true,
      });
      await expect(store.save({ ...spb("pb-locked"), version: 1 })).rejects.toThrow(
        /refusing to create/,
      );
    } finally {
      transport.close();
    }
  });
});
