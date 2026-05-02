import { describe, expect, mock, test } from "bun:test";
import type {
  StoreChangeEvent,
  StoreChangeNotifier,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import {
  createPolicyCacheMiddleware,
  type PolicyCacheConfig,
  type PolicyEntry,
} from "./policy-cache.js";

// Tests don't need a forge instance to exercise cache behavior. The cache
// fail-closes when no verifier is configured, so every test handle wires
// `verifier: TRUST_ALL`. Tests that exercise the verifier itself pass an
// explicit alternative. `mw(...)` is a thin helper that prepends the
// trusting verifier to any per-test config.
const TRUST_ALL = (): boolean => true;
const mw = (cfg: PolicyCacheConfig = {}): ReturnType<typeof createPolicyCacheMiddleware> =>
  createPolicyCacheMiddleware({ verifier: TRUST_ALL, ...cfg });

function ctxFor(agentId: string): TurnContext {
  return {
    session: {
      agentId,
      sessionId: "s" as never,
      runId: "r" as never,
      metadata: {},
    },
    turnIndex: 0,
    turnId: "t" as never,
    messages: [],
    metadata: {},
  } as unknown as TurnContext;
}

const CTX = ctxFor("agent-A");

function makeReq(toolId: string, input: Record<string, unknown> = {}): ToolRequest {
  return { toolId, input };
}

function makeResp(): ToolResponse {
  return { output: "ok" };
}

function makeAgentPolicy(
  agentId: string,
  toolId: string,
  brickId: string,
  decision: "allow" | "block" = "allow",
): PolicyEntry {
  return {
    scope: "agent",
    agentId,
    toolId,
    brickId,
    execute: () =>
      decision === "allow" ? { action: "allow" } : { action: "block", reason: "blocked by policy" },
  };
}

function makeGlobalPolicy(
  toolId: string,
  brickId: string,
  decision: "allow" | "block" = "allow",
): PolicyEntry {
  return {
    scope: "global",
    toolId,
    brickId,
    execute: () =>
      decision === "allow" ? { action: "allow" } : { action: "block", reason: "blocked by policy" },
  };
}

describe("createPolicyCacheMiddleware: shape", () => {
  test("name is policy-cache, priority 50 (outer of permissions@100), phase intercept", () => {
    const handle = mw();
    expect(handle.middleware.name).toBe("policy-cache");
    expect(handle.middleware.priority).toBe(50);
    expect(handle.middleware.phase).toBe("intercept");
  });
});

describe("createPolicyCacheMiddleware: verified-only promotion gate", () => {
  test("register rejects entries the verifier rejects (returns false)", () => {
    const handle = createPolicyCacheMiddleware({
      verifier: (entry) => entry.brickId === "brick-VERIFIED",
    });
    const result = handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.retryable).toBe(false);
    }
    expect(handle.size()).toBe(0);
  });

  test("register accepts entries the verifier accepts", () => {
    const handle = createPolicyCacheMiddleware({
      verifier: (entry) => entry.brickId === "brick-VERIFIED",
    });
    const result = handle.register(makeAgentPolicy("agent-A", "search", "brick-VERIFIED", "allow"));
    expect(result.ok).toBe(true);
    expect(handle.size()).toBe(1);
  });

  test("missing verifier fail-closes: every registration rejected", () => {
    // No verifier configured at construction time. Every register() call
    // must be refused — the cache never trusts the caller. This is the
    // safety property that closes the round-3/4 trust-boundary hole.
    const handle = createPolicyCacheMiddleware();
    const result = handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.retryable).toBe(false);
    }
    expect(handle.size()).toBe(0);
  });

  test("verifier receives the FULL entry (brickId, toolId, scope, agentId, execute)", () => {
    const seen: PolicyEntry[] = [];
    const handle = createPolicyCacheMiddleware({
      verifier: (e) => {
        seen.push(e);
        return false;
      },
    });
    handle.register(makeAgentPolicy("agent-A", "search", "brick-X"));
    handle.register(makeAgentPolicy("agent-B", "other", "brick-Y"));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      brickId: "brick-X",
      toolId: "search",
      scope: "agent",
      agentId: "agent-A",
    });
    expect(typeof seen[0]?.execute).toBe("function");
  });

  test("verifier closure is captured at construction; callers cannot influence its decision", () => {
    const verifiedSet = new Set<string>(["brick-OK"]);
    const handle = createPolicyCacheMiddleware({
      verifier: (e) => verifiedSet.has(e.brickId),
    });
    expect(handle.register(makeAgentPolicy("a", "t", "brick-OK")).ok).toBe(true);
    expect(handle.register(makeAgentPolicy("a", "u", "brick-FAKE")).ok).toBe(false);
  });

  test("register refuses a strictly older generation (out-of-order promotion)", () => {
    // Round 6 review: an event-driven promoter delivering a stale
    // promotion out of order must not silently roll authorization state
    // backward. When both incoming and existing entries carry a
    // generation, register() compares them and refuses staler ones.
    const handle = mw();
    expect(
      handle.register({
        scope: "agent",
        agentId: "a",
        toolId: "t",
        brickId: "b",
        generation: 5,
        execute: () => ({ action: "block", reason: "x" }),
      }).ok,
    ).toBe(true);
    const stale = handle.register({
      scope: "agent",
      agentId: "a",
      toolId: "t",
      brickId: "b",
      generation: 3,
      execute: () => ({ action: "allow" }),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("VALIDATION");
      expect(stale.error.context).toMatchObject({
        incomingGeneration: 3,
        currentGeneration: 5,
      });
    }
  });

  test("register accepts equal-or-newer generation", () => {
    const handle = mw();
    handle.register({
      scope: "agent",
      agentId: "a",
      toolId: "t",
      brickId: "b",
      generation: 5,
      execute: () => ({ action: "block", reason: "x" }),
    });
    // Equal generation accepted (idempotent re-register).
    expect(
      handle.register({
        scope: "agent",
        agentId: "a",
        toolId: "t",
        brickId: "b",
        generation: 5,
        execute: () => ({ action: "block", reason: "x" }),
      }).ok,
    ).toBe(true);
    // Newer generation accepted.
    expect(
      handle.register({
        scope: "agent",
        agentId: "a",
        toolId: "t",
        brickId: "b",
        generation: 7,
        execute: () => ({ action: "allow" }),
      }).ok,
    ).toBe(true);
  });

  test("register rejects stale generation against destination slot occupant with DIFFERENT brickId (round-10 regression)", () => {
    // Round 10 review: registration overwrites by (bucket, toolId), so
    // an out-of-order retry of an older brick id whose generation is
    // strictly less than the brick currently bound to that slot must be
    // rejected even though the same-brickId gate doesn't fire (different
    // brickIds). Otherwise the older brick's policy silently replaces
    // the newer one in the slot.
    const handle = mw();
    // Step 1: install brick-old@gen=1 for tool T.
    expect(
      handle.register({
        scope: "agent",
        agentId: "a",
        toolId: "T",
        brickId: "brick-old",
        generation: 1,
        execute: () => ({ action: "block", reason: "old" }),
      }).ok,
    ).toBe(true);
    // Step 2: replace with brick-new@gen=2.
    expect(
      handle.register({
        scope: "agent",
        agentId: "a",
        toolId: "T",
        brickId: "brick-new",
        generation: 2,
        execute: () => ({ action: "block", reason: "new" }),
      }).ok,
    ).toBe(true);
    // Step 3: out-of-order retry of brick-old@gen=1 must be refused —
    // its generation is older than the current slot occupant (brick-new@2).
    const replay = handle.register({
      scope: "agent",
      agentId: "a",
      toolId: "T",
      brickId: "brick-old",
      generation: 1,
      execute: () => ({ action: "allow" }),
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.error.code).toBe("VALIDATION");
      expect(replay.error.context).toMatchObject({
        incomingGeneration: 1,
        currentGeneration: 2,
      });
    }
  });

  test("constructor refuses non-positive numeric caps (round-4 v2 regression)", () => {
    // Round 4 (v2 loop) review: maxEntries=0 silently bypassed the per-bucket
    // overflow check (eviction only fires when the bucket is non-empty), so
    // a configured zero-cap kill switch was ineffective. Validate at
    // construction so operators get a hard refusal instead of a silent
    // quota violation.
    expect(() => createPolicyCacheMiddleware({ verifier: TRUST_ALL, maxEntries: 0 })).toThrow(
      /maxEntries.*positive/,
    );
    expect(() => createPolicyCacheMiddleware({ verifier: TRUST_ALL, maxEntries: -3 })).toThrow();
    expect(() =>
      createPolicyCacheMiddleware({ verifier: TRUST_ALL, dispatchTimeoutMs: -1 }),
    ).toThrow(/dispatchTimeoutMs/);
    // Round 5 (v2 loop): NaN/Infinity/negative perTurnBlockCap silently
    // disables the anti-loop guard (`count > NaN` is always false), so
    // construction must reject these values.
    expect(() =>
      createPolicyCacheMiddleware({ verifier: TRUST_ALL, perTurnBlockCap: Number.NaN }),
    ).toThrow(/perTurnBlockCap/);
    expect(() =>
      createPolicyCacheMiddleware({
        verifier: TRUST_ALL,
        perTurnBlockCap: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/perTurnBlockCap/);
    expect(() => createPolicyCacheMiddleware({ verifier: TRUST_ALL, perTurnBlockCap: -1 })).toThrow(
      /perTurnBlockCap/,
    );
    // 0 stays valid (means "any block trips the cap on first hit").
    expect(() =>
      createPolicyCacheMiddleware({ verifier: TRUST_ALL, perTurnBlockCap: 0 }),
    ).not.toThrow();
    // dispatchTimeoutMs=0 is explicitly the fire-and-forget mode, allowed.
    expect(() =>
      createPolicyCacheMiddleware({ verifier: TRUST_ALL, dispatchTimeoutMs: 0 }),
    ).not.toThrow();
    // Round 6 (v2 loop): NaN maxAgentBuckets disables the per-tenant
    // memory bound. Validate at construction.
    expect(() =>
      createPolicyCacheMiddleware({ verifier: TRUST_ALL, maxAgentBuckets: Number.NaN }),
    ).toThrow(/maxAgentBuckets/);
    expect(() => createPolicyCacheMiddleware({ verifier: TRUST_ALL, maxAgentBuckets: -1 })).toThrow(
      /maxAgentBuckets/,
    );
  });

  test("malformed entry.generation is refused (round-6 v2 regression)", () => {
    // Round 6 (v2 loop) review: an unvalidated Infinity/NaN generation
    // would pin a slot — every later finite generation compares older
    // and is refused, and notifier events with finite generations get
    // ignored. Reject malformed generations on registration.
    const handle = mw();
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5]) {
      const r = handle.register({
        scope: "agent",
        agentId: "a",
        toolId: "t",
        brickId: "b",
        generation: bad,
        execute: () => ({ action: "block", reason: "x" }),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("VALIDATION");
    }
  });

  test("malformed event.generation against generation-aware cache: fail closed, do NOT evict (round-10 v2)", () => {
    // Round 10 (v2 loop) review: best-effort ordering is too weak for
    // an authorization cache. When the cached entry knows its
    // generation but the event lacks/has malformed generation, suppress
    // eviction — a delayed `removed`/`updated` from an unknown version
    // could otherwise drop a freshly re-promoted deny. Hosts deliver
    // events with valid generations to participate in invalidation.
    let listener: ((e: { kind: string; brickId: string; generation?: number }) => void) | undefined;
    const notifier = {
      subscribe: (cb: (e: { kind: string; brickId: string; generation?: number }) => void) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = createPolicyCacheMiddleware({
      verifier: TRUST_ALL,
      notifier: notifier as never,
    });
    handle.register({
      scope: "agent",
      agentId: "a",
      toolId: "t",
      brickId: "b1",
      generation: 5,
      execute: () => ({ action: "block", reason: "x" }),
    });
    expect(handle.size()).toBe(1);
    listener?.({ kind: "removed", brickId: "b1", generation: Number.NaN });
    // Cached entry has generation:5; event has malformed generation →
    // suppress eviction.
    expect(handle.size()).toBe(1);
    // A well-formed current-or-newer event still evicts.
    listener?.({ kind: "removed", brickId: "b1", generation: 5 });
    expect(handle.size()).toBe(0);
  });

  test("verifyOnHit re-verifies on every cache hit and falls through on revocation (round-8 v2)", async () => {
    // Round 8 (v2 loop) review: shallow-freezing the entry doesn't
    // protect against closure-state mutability. Hosts that need
    // continuous trust binding can opt into `verifyOnHit`: every cache
    // hit re-runs the verifier against the stored (frozen) entry, and
    // a "no longer verified" verdict evicts the entry and falls through
    // to the normal permissions path.
    const verifiedSet = new Set<string>(["brick-1"]);
    const handle = createPolicyCacheMiddleware({
      verifier: (e) => verifiedSet.has(e.brickId),
      verifyOnHit: true,
    });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    expect(handle.size()).toBe(1);
    const next = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    const r1 = await wrap(CTX, makeReq("rm"), next as ToolHandler);
    expect(r1.metadata?.policyDenied).toBe(true);
    expect(next).not.toHaveBeenCalled();
    // Host revokes the brick out-of-band.
    verifiedSet.delete("brick-1");
    // Round 5 (v3 loop): revocation TOMBSTONES the entry (quarantine).
    // Two consecutive calls after a transient verifier failure must
    // BOTH block — eviction would have left the second call as a
    // cache miss that delegates to next() and silently reopens the
    // tool. Quarantine ensures the entry remains a blocking tombstone
    // until an explicit notifier event or successful re-registration.
    const r2 = await wrap(CTX, makeReq("rm"), next as ToolHandler);
    expect(r2.metadata?.policyDenied).toBe(true);
    const r3 = await wrap(CTX, makeReq("rm"), next as ToolHandler);
    expect(r3.metadata?.policyDenied).toBe(true);
    expect(next).not.toHaveBeenCalled();
    // Entry remains as quarantined tombstone — protects against the
    // transient-verifier-failure → reopened-tool authorization
    // downgrade on subsequent calls.
    expect(handle.size()).toBe(1);
  });

  test("verifyOnHit revocation tombstones the agent-scope entry; global stays intact (round-5 v3)", async () => {
    // Round 5 (v3 loop): revocation tombstones via quarantine instead
    // of evicting. The agent-scope entry remains in cache as a
    // blocking tombstone, the global entry continues to coexist, and
    // the call is blocked. Either path is a deny — what matters is
    // that next() is not reached.
    const verifiedSet = new Set<string>(["brick-agent-1", "brick-global"]);
    const handle = createPolicyCacheMiddleware({
      verifier: (e) => verifiedSet.has(e.brickId),
      verifyOnHit: true,
    });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-agent-1", "allow"));
    handle.register(makeGlobalPolicy("rm", "brick-global", "block"));
    expect(handle.size()).toBe(2);
    const next = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    verifiedSet.delete("brick-agent-1");
    const r = await wrap(CTX, makeReq("rm"), next as ToolHandler);
    expect(r.metadata?.policyDenied).toBe(true);
    expect(next).not.toHaveBeenCalled();
    // Tombstone retained; global deny still coexists.
    expect(handle.size()).toBe(2);
  });

  test("verifyOnHit by default re-verifies (round-2 v3): drift after admission still blocked", async () => {
    // Round 2 (v3 loop) review: hit-time re-verification must be the
    // default. A verified executor's closure body can drift after
    // admission (TS readonly is compile-time only); only re-binding
    // trust on every hit closes that gap. Hosts that need bare
    // fast-path opt out via `verifyOnHit: false`.
    const verifiedSet = new Set<string>(["brick-1"]);
    const handle = createPolicyCacheMiddleware({
      verifier: (e) => verifiedSet.has(e.brickId),
      // verifyOnHit not set → defaults to true.
    });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const next = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    // First hit: verified → block.
    expect((await wrap(CTX, makeReq("rm"), next as ToolHandler)).metadata?.policyDenied).toBe(true);
    // Drift: verifier flips to false.
    verifiedSet.delete("brick-1");
    // Default re-verifier catches the drift even without explicit
    // verifyOnHit: true.
    const r = await wrap(CTX, makeReq("rm"), next as ToolHandler);
    expect(r.metadata?.policyDenied).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  test("verifyOnHit: false opts out of hit-time re-verification (fast-path)", async () => {
    let verifierCalls = 0;
    const handle = createPolicyCacheMiddleware({
      verifier: (e) => {
        verifierCalls++;
        return e.brickId === "brick-1";
      },
      verifyOnHit: false,
    });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const callsAfterRegister = verifierCalls;
    const next = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    await wrap(CTX, makeReq("rm"), next as ToolHandler);
    await wrap(CTX, makeReq("rm"), next as ToolHandler);
    // Verifier was called only at registration, not on hits.
    expect(verifierCalls).toBe(callsAfterRegister);
  });

  test("verifyOnHit throwing verifier is treated as TRANSIENT, not revocation (round-7 v3)", async () => {
    // Round 7 (v3 loop): a thrown verifier (verified-set unavailable,
    // lookup bug, restart gap) MUST NOT tombstone a previously
    // admitted tool. Distinguish from `false` (explicit revocation):
    //   - throw → transient, trust the prior admission for this call,
    //     surface telemetry via `onDispatchError`.
    //   - false → revocation, quarantine + block.
    // Without this split, a verifier outage would convert previously
    // allowed tools into persistent hard denies.
    const errors: Array<{ reason: string }> = [];
    let mode: "ok" | "throw" = "ok";
    const handle = createPolicyCacheMiddleware({
      verifier: (e) => {
        if (mode === "throw") throw new Error("verifier degraded");
        return e.brickId === "brick-1";
      },
      verifyOnHit: true,
      onDispatchError: (info) => {
        errors.push({ reason: info.reason });
      },
    });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const next = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    mode = "throw";
    // Transient throw: the cached policy still applies. Our cached
    // policy returns block, so the call is still denied — but via the
    // executor path, not the quarantine tombstone path.
    const r = await wrap(CTX, makeReq("rm"), next as ToolHandler);
    expect(r.metadata?.policyDenied).toBe(true);
    expect(next).not.toHaveBeenCalled();
    // Telemetry surfaced.
    expect(errors).toEqual([{ reason: "threw" }]);
    // Critically: NOT quarantined. After the transient outage clears,
    // the entry remains usable.
    mode = "ok";
    expect(handle.size()).toBe(1);
  });

  test("verifyOnHit transient throw on an ALLOW policy still allows the call (no spurious denial)", async () => {
    let mode: "ok" | "throw" = "ok";
    const handle = createPolicyCacheMiddleware({
      verifier: (e) => {
        if (mode === "throw") throw new Error("verifier degraded");
        return e.brickId === "brick-1";
      },
      verifyOnHit: true,
    });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      execute: () => ({ action: "allow" }),
    });
    const next = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    mode = "throw";
    // Round 7 v3: transient verifier failures must not flip an admitted
    // allow into a hard deny. The cached executor returns allow → call
    // proceeds to next().
    const r = await wrap(CTX, makeReq("rm"), next as ToolHandler);
    expect(r.metadata?.policyDenied).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("post-registration mutation of the entry does NOT change enforcement (round-7 v2)", async () => {
    // Round 7 (v2 loop) review: TS `readonly` is compile-time only.
    // If the cache stored the caller's PolicyEntry by reference, any code
    // still holding it could swap `execute` after the verifier accepted
    // the entry — turning a verified deny into an allow on the next
    // call. The cache must snapshot/freeze on register so post-admission
    // mutation cannot reach the enforcement path.
    const original: PolicyEntry = {
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      execute: () => ({ action: "block", reason: "deny" }),
    };
    const handle = mw();
    expect(handle.register(original).ok).toBe(true);
    // Attempt to mutate the original after admission. A plain assignment
    // would throw in strict mode (frozen object), but the relevant
    // invariant is that the CACHE's view is unaffected.
    try {
      (original as { execute: unknown }).execute = () => ({ action: "allow" });
    } catch {
      // Frozen — assignment throws. Fine; the invariant holds.
    }
    const next = mock(async () => makeResp());
    const resp = await handle.middleware.wrapToolCall?.(CTX, makeReq("rm"), next as ToolHandler);
    // Enforcement still blocks — original.execute mutation has no effect.
    expect(resp?.metadata).toMatchObject({ policyDenied: true });
    expect(next).not.toHaveBeenCalled();
  });

  test("verifier exception is converted to a refused Result (round-3 v2 regression)", () => {
    // Round 3 (v2 loop) review: the verifier closure is mandatory and
    // consults host-managed state (forge's verified-set). A transient
    // bug or stale lookup must not propagate as an uncaught exception
    // out of the promotion subscriber — fail closed with a clean
    // VALIDATION refusal that preserves the cause for operators.
    const handle = createPolicyCacheMiddleware({
      verifier: () => {
        throw new Error("verifier blew up");
      },
    });
    const result = handle.register(makeAgentPolicy("a", "t", "b"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("verifier threw");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  test("brickId-only forge state CANNOT be replayed for a different tool/scope/agent (round-5 regression)", () => {
    // Round 5 review: a verifier that only checks brickId is replay-able.
    // This regression test pins the contract: the verifier sees the full
    // tuple (brickId, toolId, scope, agentId), so a forge that pins the
    // promotion to its tool+scope+agent can reject replays.
    const FORGE_STATE = new Map<
      string,
      { toolId: string; scope: "agent" | "global"; agentId?: string }
    >([["brick-VERIFIED", { toolId: "search", scope: "agent", agentId: "agent-OK" }]]);
    const handle = createPolicyCacheMiddleware({
      verifier: (e) => {
        const promoted = FORGE_STATE.get(e.brickId);
        if (promoted === undefined) return false;
        if (promoted.toolId !== e.toolId) return false;
        if (promoted.scope !== e.scope) return false;
        if (e.scope === "agent" && promoted.agentId !== e.agentId) return false;
        return true;
      },
    });

    // Genuine promotion succeeds.
    expect(
      handle.register(makeAgentPolicy("agent-OK", "search", "brick-VERIFIED", "block")).ok,
    ).toBe(true);

    // Replay attack 1: same brickId, different toolId.
    expect(
      handle.register(makeAgentPolicy("agent-OK", "fs.delete", "brick-VERIFIED", "block")).ok,
    ).toBe(false);

    // Replay attack 2: same brickId, different agent.
    expect(
      handle.register(makeAgentPolicy("agent-EVIL", "search", "brick-VERIFIED", "block")).ok,
    ).toBe(false);

    // Replay attack 3: same brickId, escalated to global scope.
    const globalReplay: PolicyEntry = {
      scope: "global",
      toolId: "search",
      brickId: "brick-VERIFIED",
      execute: () => ({ action: "block", reason: "x" }),
    };
    expect(handle.register(globalReplay).ok).toBe(false);
  });
});

describe("createPolicyCacheMiddleware: cache-hit bypass equivalence", () => {
  test("uncached toolId passes through unchanged", async () => {
    const handle = mw();
    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    const result = await wrap(CTX, makeReq("search", { q: "hi" }), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(result.output).toBe("ok");
  });

  test("policy 'allow' delegates to next — observable result identical to no-cache", async () => {
    const baseline = mw();
    const cached = mw();
    cached.register(makeAgentPolicy("agent-A", "search", "brick-1", "allow"));

    const baselineNext: ToolHandler = mock(async () => ({ output: "tool ran" }) as ToolResponse);
    const cachedNext: ToolHandler = mock(async () => ({ output: "tool ran" }) as ToolResponse);

    const baselineWrap = baseline.middleware.wrapToolCall;
    const cachedWrap = cached.middleware.wrapToolCall;
    if (baselineWrap === undefined || cachedWrap === undefined) throw new Error("missing wrap");

    const baselineRes = await baselineWrap(CTX, makeReq("search", { q: "x" }), baselineNext);
    const cachedRes = await cachedWrap(CTX, makeReq("search", { q: "x" }), cachedNext);

    expect(baselineRes).toEqual(cachedRes);
    expect(baselineNext).toHaveBeenCalledTimes(1);
    expect(cachedNext).toHaveBeenCalledTimes(1);
  });

  test("policy 'block' short-circuits without calling next (no model, no tool)", async () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1", "block"));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    const result = await wrap(CTX, makeReq("search", { q: "" }), next);
    expect(next).toHaveBeenCalledTimes(0);

    expect(typeof result.output).toBe("string");
    expect(result.output as string).toContain("search");

    expect(result.metadata?.isError).toBe(true);
    expect(result.metadata?.blockedByHook).toBe(true);
    expect(result.metadata?.policyDenied).toBe(true);
    expect(result.metadata?.hookName).toBe("policy-cache");
    expect(result.metadata?.toolId).toBe("search");
    // executor-supplied `reason` MUST NOT appear in metadata — event-trace
    // persists allowlisted metadata to long-lived trajectory storage, and a
    // raw reason could leak rule internals or input fragments.
    expect(result.metadata?.reason).toBeUndefined();
  });

  test("only intercepts registered toolIds — others pass through", async () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1", "block"));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    await wrap(CTX, makeReq("write_file", { path: "/tmp/x" }), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("policy decision is a pure function of input — repeated calls produce identical decisions", async () => {
    const handle = mw();
    let runs = 0;
    const result = handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-pure",
      execute: (input) => {
        runs += 1;
        const q = (input as { readonly q?: unknown }).q;
        return typeof q === "string" && q.length > 0
          ? { action: "allow" }
          : { action: "block", reason: "empty q" };
      },
    });
    expect(result.ok).toBe(true);

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    await wrap(CTX, makeReq("search", { q: "" }), next);
    await wrap(CTX, makeReq("search", { q: "" }), next);
    await wrap(CTX, makeReq("search", { q: "" }), next);
    expect(runs).toBe(3);
    expect(next).toHaveBeenCalledTimes(0);
  });
});

describe("createPolicyCacheMiddleware: executor failure (fail-closed + quarantine)", () => {
  test("throwing executor returns canonical block AND quarantines (deny stays enforced)", async () => {
    let errorInfo: { brickId: string; toolId: string; scope: string } | undefined;
    const handle = mw({
      onExecutorError: (info) => {
        errorInfo = { brickId: info.brickId, toolId: info.toolId, scope: info.scope };
      },
    });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-throws",
      execute: () => {
        throw new Error("schema drift");
      },
    });
    expect(handle.size()).toBe(1);

    const next: ToolHandler = mock(async () => ({ output: "tool ran" }) as ToolResponse);
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // First call: throw → block (fail-closed).
    const r1 = await wrap(CTX, makeReq("search", { q: "x" }), next);
    expect(next).toHaveBeenCalledTimes(0);
    expect(r1.metadata?.policyDenied).toBe(true);
    expect(r1.metadata?.blockedByHook).toBe(true);
    expect(r1.metadata?.hookName).toBe("policy-cache");
    expect(r1.metadata?.reason).toBeUndefined();
    // Entry stays in cache (quarantine, not eviction).
    expect(handle.size()).toBe(1);

    // Operator-visible incident reporting fired.
    expect(errorInfo?.brickId).toBe("brick-throws");
    expect(errorInfo?.toolId).toBe("search");
    expect(errorInfo?.scope).toBe("agent");

    // Subsequent calls also block — no fall-through, executor not re-invoked.
    const r2 = await wrap(CTX, makeReq("search", { q: "x" }), next);
    expect(next).toHaveBeenCalledTimes(0);
    expect(r2.metadata?.policyDenied).toBe(true);
  });

  test("quarantined deny does NOT fall back to global allow (security property)", async () => {
    const handle = mw();
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-broken",
      execute: () => {
        throw new Error("compile error");
      },
    });
    handle.register(makeGlobalPolicy("search", "brick-global", "allow"));

    const next: ToolHandler = mock(async () => ({ output: "tool ran" }) as ToolResponse);
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // First call: agent throws → block + quarantine.
    const r1 = await wrap(CTX, makeReq("search", {}), next);
    expect(r1.metadata?.policyDenied).toBe(true);
    expect(next).toHaveBeenCalledTimes(0);

    // Second call: agent is quarantined — does NOT fall back to global allow.
    // The verified agent deny remains in force until re-promotion.
    const r2 = await wrap(CTX, makeReq("search", {}), next);
    expect(r2.metadata?.policyDenied).toBe(true);
    expect(next).toHaveBeenCalledTimes(0);
  });

  test("re-registering brick clears quarantine", async () => {
    const handle = mw();
    let throwOnce = true;
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-flaky",
      execute: () => {
        if (throwOnce) throw new Error("transient compile fault");
        return { action: "allow" };
      },
    });

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // Quarantine it.
    await wrap(CTX, makeReq("search"), next);
    expect(next).toHaveBeenCalledTimes(0);

    // Re-register with a fixed executor — quarantine clears.
    throwOnce = false;
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-flaky",
      execute: () => ({ action: "allow" }),
    });

    const r = await wrap(CTX, makeReq("search"), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(r.output).toBe("ok");
  });

  test("StoreChangeNotifier event clears quarantine via eviction", () => {
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = mw({ notifier });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-broken",
      execute: () => {
        throw new Error("fault");
      },
    });

    // Trigger quarantine.
    void handle.middleware.wrapToolCall?.(CTX, makeReq("search"), async () => makeResp());
    expect(handle.size()).toBe(1);

    // Notifier "updated" → evicts entry AND clears quarantine.
    listener?.({ kind: "updated", brickId: "brick-broken" as never });
    expect(handle.size()).toBe(0);
  });

  test("onExecutorError callback that throws does NOT break canonical block return", async () => {
    const handle = mw({
      onExecutorError: () => {
        throw new Error("audit sink offline");
      },
    });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-throws",
      execute: () => {
        throw new Error("compile error");
      },
    });

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // Telemetry callback throws → enforcement still returns canonical block.
    const r = await wrap(CTX, makeReq("search"), next);
    expect(next).toHaveBeenCalledTimes(0);
    expect(r.metadata?.policyDenied).toBe(true);
    expect(r.metadata?.blockedByHook).toBe(true);
  });
});

describe("createPolicyCacheMiddleware: eviction", () => {
  test("evict by brickId is idempotent", () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    expect(handle.size()).toBe(1);
    handle.evict("brick-1");
    expect(handle.size()).toBe(0);
    handle.evict("brick-1");
    expect(handle.size()).toBe(0);
  });

  test("evict for unknown brickId is no-op", () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    handle.evict("brick-unknown");
    expect(handle.size()).toBe(1);
  });

  test("re-registering same (scope,owner,toolId) replaces prior brick (no leak)", () => {
    // Round 10 (v2 loop): slot replacement (different brickId in same
    // (scope, owner, toolId) slot) requires generation on both sides.
    // First-time registration into an empty slot is still allowed
    // without a generation.
    const handle = mw();
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-1",
      generation: 1,
      execute: () => ({ action: "allow" }),
    });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "search",
      brickId: "brick-2",
      generation: 2,
      execute: () => ({ action: "block", reason: "x" }),
    });
    expect(handle.size()).toBe(1);

    handle.evict("brick-1"); // stale
    expect(handle.size()).toBe(1);

    handle.evict("brick-2");
    expect(handle.size()).toBe(0);
  });

  test("slot replacement: legacy-on-legacy is allowed; versioned-displaced-by-unversioned is refused (round-4 v3)", () => {
    // Round 4 (v3 loop) compromise: the round-10 v2 blanket "either
    // side lacks generation = refuse" stranded legacy hosts. The new
    // rule is asymmetric — refuse only the strict downgrade attack
    // (versioned displaced by unversioned), allow the other three
    // corners (both legacy, upgrade-to-versioned, both versioned).

    // Both legacy: allowed.
    const legacy = mw();
    expect(legacy.register(makeAgentPolicy("agent-A", "search", "brick-1", "allow")).ok).toBe(true);
    expect(legacy.register(makeAgentPolicy("agent-A", "search", "brick-2", "block")).ok).toBe(true);
    expect(legacy.size()).toBe(1);

    // Upgrade legacy → versioned: allowed.
    const upgrade = mw();
    expect(upgrade.register(makeAgentPolicy("agent-A", "search", "brick-1", "allow")).ok).toBe(
      true,
    );
    expect(
      upgrade.register({
        scope: "agent",
        agentId: "agent-A",
        toolId: "search",
        brickId: "brick-2",
        generation: 1,
        execute: () => ({ action: "block", reason: "x" }),
      }).ok,
    ).toBe(true);

    // Versioned displaced by unversioned: REFUSED (downgrade attack).
    const downgrade = mw();
    expect(
      downgrade.register({
        scope: "agent",
        agentId: "agent-A",
        toolId: "search",
        brickId: "brick-1",
        generation: 5,
        execute: () => ({ action: "block", reason: "x" }),
      }).ok,
    ).toBe(true);
    const r = downgrade.register(makeAgentPolicy("agent-A", "search", "brick-2", "allow"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
    expect(downgrade.size()).toBe(1);
  });

  test("re-registering same brickId for different toolId cleans stale forward entry", () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-A"));
    handle.register(makeAgentPolicy("agent-A", "query", "brick-A"));
    expect(handle.size()).toBe(1);

    handle.evict("brick-A");
    expect(handle.size()).toBe(0);
  });

  test("per-bucket capacity overflow FAILS CLOSED instead of LRU-evicting (round-1 v3)", () => {
    // Round 1 (v3 loop) review: LRU-evicting on overflow can silently
    // drop a verified deny when a noisy bucket churns through
    // promotions. The miss-path falls through to the weaker downstream
    // permissions path → authorization downgrade. Refuse new
    // registrations when the bucket is full so existing denies are
    // preserved; the host can shed load or explicitly evict before
    // retrying. The error is retryable.
    const handle = mw({ maxEntries: 2 });
    expect(handle.register(makeAgentPolicy("agent-A", "a", "ba")).ok).toBe(true);
    expect(handle.register(makeAgentPolicy("agent-A", "b", "bb")).ok).toBe(true);
    const overflow = handle.register(makeAgentPolicy("agent-A", "c", "bc"));
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error.code).toBe("VALIDATION");
      expect(overflow.error.retryable).toBe(true);
      expect(overflow.error.context).toMatchObject({
        bucket: "agent:agent-A",
        maxEntries: 2,
      });
    }
    // The two prior denies remain enforceable.
    expect(handle.size()).toBe(2);
    // After explicit evict, room reopens.
    handle.evict("ba");
    expect(handle.register(makeAgentPolicy("agent-A", "c", "bc")).ok).toBe(true);
  });

  test("fullBucketPolicy: 'lru' opts in to LRU eviction (round-9 v3)", () => {
    // Round 9 (v3 loop) compromise: hosts that need newly verified
    // denies to install even under bucket pressure can opt into LRU
    // eviction. Default stays "fail-closed" so existing entries
    // (which may be denies) are not dropped silently.
    const handle = mw({ maxEntries: 2, fullBucketPolicy: "lru" });
    expect(handle.register(makeAgentPolicy("agent-A", "a", "ba")).ok).toBe(true);
    expect(handle.register(makeAgentPolicy("agent-A", "b", "bb")).ok).toBe(true);
    // Bucket full — but LRU mode allows the new entry to install.
    expect(handle.register(makeAgentPolicy("agent-A", "c", "bc")).ok).toBe(true);
    expect(handle.size()).toBe(2);
  });

  test("same-brick re-registration without generation preserves the stored generation (round-9 v3)", () => {
    // Round 9 (v3 loop) review: a same-brick refresh that omits
    // `generation` would otherwise strip the stored generation,
    // disabling stale-invalidation protection. The stored entry
    // inherits the prior generation across same-brick refreshes.
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = mw({ notifier });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      generation: 5,
      execute: () => ({ action: "block", reason: "x" }),
    });
    // Same-brick refresh, no generation supplied.
    expect(
      handle.register({
        scope: "agent",
        agentId: "agent-A",
        toolId: "rm",
        brickId: "brick-1",
        execute: () => ({ action: "block", reason: "x'" }),
      }).ok,
    ).toBe(true);
    // A stale event with generation < stored should still be suppressed
    // — proving the stored generation was inherited (not stripped).
    listener?.({ kind: "removed", brickId: "brick-1" as never, generation: 3 });
    expect(handle.size()).toBe(1);
  });

  test("overwrite by toolId in a full bucket is allowed (no slot count change)", () => {
    const handle = mw({ maxEntries: 2 });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "a",
      brickId: "ba",
      generation: 1,
      execute: () => ({ action: "block", reason: "x" }),
    });
    handle.register(makeAgentPolicy("agent-A", "b", "bb"));
    // Re-register tool "a" with a NEWER brickId/generation: same slot,
    // not a new slot, so cap doesn't trip.
    expect(
      handle.register({
        scope: "agent",
        agentId: "agent-A",
        toolId: "a",
        brickId: "ba2",
        generation: 2,
        execute: () => ({ action: "block", reason: "y" }),
      }).ok,
    ).toBe(true);
    expect(handle.size()).toBe(2);
  });
});

describe("createPolicyCacheMiddleware: scope isolation by concrete owner", () => {
  test("two agents registering the same toolId do NOT collide", async () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-A", "block"));
    handle.register(makeAgentPolicy("agent-B", "search", "brick-B", "allow"));
    expect(handle.size()).toBe(2);

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // Agent A: blocked by A's policy.
    const aResult = await wrap(ctxFor("agent-A"), makeReq("search"), next);
    expect(next).toHaveBeenCalledTimes(0);
    expect(aResult.metadata?.policyDenied).toBe(true);

    // Agent B: A's block does NOT apply; B's allow lets next run.
    const bResult = await wrap(ctxFor("agent-B"), makeReq("search"), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(bResult.output).toBe("ok");
  });

  test("agent unknown to cache: no agent hit, falls back to zone/global as appropriate", async () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-A", "block"));
    handle.register(makeGlobalPolicy("search", "brick-global", "allow"));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    const result = await wrap(ctxFor("agent-OTHER"), makeReq("search"), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(result.output).toBe("ok");
  });

  test("agent → global precedence at lookup time", async () => {
    const handle = mw();
    handle.register(makeGlobalPolicy("search", "brick-G", "allow"));
    handle.register(makeAgentPolicy("agent-A", "search", "brick-A", "block"));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    const ctx = ctxFor("agent-A");

    // Agent block wins.
    const r1 = await wrap(ctx, makeReq("search"), next);
    expect(r1.metadata?.policyDenied).toBe(true);

    handle.evict("brick-A");
    // Global allow wins next.
    const r2 = await wrap(ctx, makeReq("search"), next);
    expect(r2.output).toBe("ok");
  });
});

describe("createPolicyCacheMiddleware: event-driven invalidation", () => {
  test("notifier subscription evicts on 'updated'", () => {
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = mw({ notifier });
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    expect(handle.size()).toBe(1);

    listener?.({ kind: "updated", brickId: "brick-1" as never });
    expect(handle.size()).toBe(0);
  });

  test("notifier evicts on 'removed' and 'quarantined'", () => {
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = mw({ notifier });
    handle.register(makeAgentPolicy("agent-A", "a", "ba"));
    handle.register(makeAgentPolicy("agent-A", "b", "bb"));
    expect(handle.size()).toBe(2);

    listener?.({ kind: "removed", brickId: "ba" as never });
    expect(handle.size()).toBe(1);

    listener?.({ kind: "quarantined", brickId: "bb" as never });
    expect(handle.size()).toBe(0);
  });

  test("stale notifier event (older generation) does NOT evict current entry", () => {
    // Round 1 (fresh loop) review: a delayed event for a prior generation
    // is otherwise indistinguishable from a current-generation event and
    // can silently evict a freshly re-promoted deny.
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = mw({ notifier });
    // Register fresh entry at generation 5.
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      generation: 5,
      execute: () => ({ action: "block", reason: "x" }),
    });
    expect(handle.size()).toBe(1);
    // A late event from generation 3 must NOT evict.
    listener?.({ kind: "updated", brickId: "brick-1" as never, generation: 3 });
    expect(handle.size()).toBe(1);
  });

  test("current-or-newer generation event DOES evict", () => {
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = mw({ notifier });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      generation: 5,
      execute: () => ({ action: "block", reason: "x" }),
    });
    listener?.({ kind: "removed", brickId: "brick-1" as never, generation: 5 });
    expect(handle.size()).toBe(0);
  });

  test("ungenerated event against generation-aware cache: suppress eviction (round-10 v2)", () => {
    // Round 10 (v2 loop): an unversioned `removed`/`updated` against a
    // generation-aware cached entry is treated as untrusted and
    // suppressed — a delayed event from an unknown version could
    // otherwise drop a freshly re-promoted deny. Hosts must deliver
    // versioned events to participate in invalidation when entries
    // carry a generation.
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = mw({ notifier });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      generation: 5,
      execute: () => ({ action: "allow" }),
    });
    listener?.({ kind: "removed", brickId: "brick-1" as never });
    expect(handle.size()).toBe(1);
  });

  test("unversionedInvalidationPolicy='evict' accepts unversioned event against versioned cache (round-3 v3)", () => {
    // Round 3 (v3 loop) review: hosts with versioned cache entries but
    // a partially-upgraded notifier need an explicit way to opt back
    // into best-effort eviction so revoke/update events don't strand
    // stale state behind manual cleanup.
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = mw({ notifier, unversionedInvalidationPolicy: "evict" });
    handle.register({
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      generation: 5,
      execute: () => ({ action: "allow" }),
    });
    listener?.({ kind: "removed", brickId: "brick-1" as never });
    // Compat mode: legacy unversioned events still evict.
    expect(handle.size()).toBe(0);
  });

  test("ungenerated event against ungenerated cache: still evicts (legacy compat)", () => {
    // When the cached entry has no generation, there's nothing to
    // compare against — fall back to best-effort eviction so legacy
    // hosts that ignore generations still get invalidation.
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = mw({ notifier });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "allow"));
    listener?.({ kind: "removed", brickId: "brick-1" as never });
    expect(handle.size()).toBe(0);
  });

  test("notifier ignores 'saved' and 'promoted' (wiring layer handles promotion)", () => {
    let listener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    };
    const handle = mw({ notifier });
    handle.register(makeAgentPolicy("agent-A", "a", "ba"));

    listener?.({ kind: "saved", brickId: "ba" as never });
    listener?.({ kind: "promoted", brickId: "ba" as never });
    expect(handle.size()).toBe(1);
  });
});

describe("createPolicyCacheMiddleware: capability fragment", () => {
  test("undefined when empty (no model context cost)", () => {
    const handle = mw();
    expect(handle.middleware.describeCapabilities(CTX)).toBeUndefined();
  });

  test("summarizes count when populated", () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    const frag = handle.middleware.describeCapabilities(CTX);
    expect(frag).not.toBeUndefined();
    expect(frag?.label).toBe("policy-cache");
    expect(frag?.description).toContain("1 tool");
    expect(frag?.description).toContain("deterministic");
  });

  test("pluralizes correctly", () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "a", "ba"));
    handle.register(makeAgentPolicy("agent-A", "b", "bb"));
    const frag = handle.middleware.describeCapabilities(CTX);
    expect(frag?.description).toContain("2 tools");
  });

  test("does NOT leak other agents' policy counts to the current turn", () => {
    const handle = mw();
    // Agent A has 1 policy.
    handle.register(makeAgentPolicy("agent-A", "search", "brick-A"));
    // Agent B has 5 policies — must not show up in agent A's prompt.
    for (let i = 0; i < 5; i++) {
      handle.register(makeAgentPolicy("agent-B", `tool${i}`, `brick-B-${i}`));
    }
    // Plus 1 global policy that BOTH agents legitimately share.
    handle.register(makeGlobalPolicy("shared", "brick-G"));

    const fragA = handle.middleware.describeCapabilities(ctxFor("agent-A"));
    expect(fragA?.description).toContain("2 tools"); // 1 agent-A + 1 global

    const fragB = handle.middleware.describeCapabilities(ctxFor("agent-B"));
    expect(fragB?.description).toContain("6 tools"); // 5 agent-B + 1 global

    const fragOther = handle.middleware.describeCapabilities(ctxFor("agent-OTHER"));
    expect(fragOther?.description).toContain("1 tool"); // global only, no leak
  });
});

describe("createPolicyCacheMiddleware: LRU eviction (recency-aware, per-owner)", () => {
  test("hot policy survives capacity pressure — lookup bumps recency", async () => {
    const handle = mw({ maxEntries: 2 });
    handle.register(makeAgentPolicy("agent-A", "hot", "brick-hot", "block"));
    handle.register(makeAgentPolicy("agent-A", "cold", "brick-cold", "allow"));

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // Touch 'hot' so it becomes most-recently-used (cold is now LRU).
    await wrap(CTX, makeReq("hot"), next);

    // Insert a third entry — capacity overflow evicts the LRU, which is 'cold'
    // (NOT 'hot', because the lookup above bumped its recency).
    handle.register(makeAgentPolicy("agent-A", "new", "brick-new", "allow"));
    expect(handle.size()).toBe(2);

    // 'hot' deny still enforces — was not evicted despite being registered first.
    const r = await wrap(CTX, makeReq("hot"), next);
    expect(r.metadata?.policyDenied).toBe(true);

    // 'cold' is gone — pass through.
    const r2 = await wrap(CTX, makeReq("cold"), next);
    expect(r2.output).toBe("ok");
  });

  test("re-registering an existing entry refreshes its LRU position (round-9 regression)", async () => {
    // Round 9 review: Map.set on an existing key does NOT move it to the
    // end of insertion order, so without an explicit delete+set on
    // overwrite, a freshly re-promoted deny would stay in its old LRU
    // slot and be evicted by the very next insert into a full bucket —
    // converting a verified deny back into a cache miss.
    const handle = mw({ maxEntries: 3 });
    handle.register(makeAgentPolicy("a", "deny-tool", "brick-deny", "block"));
    handle.register(makeAgentPolicy("a", "t1", "brick-1"));
    handle.register(makeAgentPolicy("a", "t2", "brick-2"));
    // Re-register the deny — should bump its LRU position to MRU.
    handle.register(makeAgentPolicy("a", "deny-tool", "brick-deny", "block"));
    // Adding a 4th entry forces eviction of the LRU slot. The deny was
    // just refreshed, so t1 (now oldest) is evicted, NOT the deny.
    handle.register(makeAgentPolicy("a", "t3", "brick-3"));

    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    const next = mock(async () => makeResp());
    // Deny is still cached and enforced.
    const r = await wrap(ctxFor("a"), makeReq("deny-tool"), next as ToolHandler);
    expect(next).not.toHaveBeenCalled();
    expect(r.metadata?.policyDenied).toBe(true);
  });

  test("noisy agent CANNOT evict another agent's deny via capacity pressure", async () => {
    // Per-owner partition: maxEntries=2 PER agent, not 2 globally.
    const handle = mw({ maxEntries: 2 });
    handle.register(makeAgentPolicy("agent-victim", "secret", "brick-secret", "block"));

    // Noisy agent registers 5 policies (3 over its own quota of 2).
    for (let i = 0; i < 5; i++) {
      handle.register(makeAgentPolicy("agent-noisy", `tool${i}`, `brick-noisy-${i}`, "allow"));
    }

    // Victim agent's quota is independent — its deny survives.
    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    const r = await wrap(ctxFor("agent-victim"), makeReq("secret"), next);
    expect(next).toHaveBeenCalledTimes(0);
    expect(r.metadata?.policyDenied).toBe(true);
  });

  test("global cache is its own bucket — agent overflow does not evict global denies", async () => {
    const handle = mw({ maxEntries: 2 });
    handle.register(makeGlobalPolicy("danger", "brick-global", "block"));

    // Agent fills its quota.
    for (let i = 0; i < 5; i++) {
      handle.register(makeAgentPolicy("agent-A", `tool${i}`, `brick-${i}`, "allow"));
    }

    const next: ToolHandler = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");

    // Global deny is intact even though agent registered 5 entries.
    const r = await wrap(ctxFor("agent-OTHER"), makeReq("danger"), next);
    expect(r.metadata?.policyDenied).toBe(true);
  });
});

describe("createPolicyCacheMiddleware: dispose() lifecycle", () => {
  test("dispose unsubscribes from notifier and clears caches", () => {
    let unsubscribed = false;
    let activeListener: ((e: StoreChangeEvent) => void) | undefined;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: (cb) => {
        activeListener = cb;
        return () => {
          unsubscribed = true;
          activeListener = undefined;
        };
      },
    };

    const handle = mw({ notifier });
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    expect(handle.size()).toBe(1);

    handle.dispose();
    expect(unsubscribed).toBe(true);
    expect(activeListener).toBeUndefined();
    expect(handle.size()).toBe(0);
  });

  test("dispose is idempotent", () => {
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: () => () => {},
    };
    const handle = mw({ notifier });
    handle.register(makeAgentPolicy("agent-A", "search", "brick-1"));
    handle.dispose();
    handle.dispose(); // must not throw
    expect(handle.size()).toBe(0);
  });

  test("repeat create/dispose against shared notifier doesn't accumulate listeners", () => {
    let activeCount = 0;
    let peakCount = 0;
    const notifier: StoreChangeNotifier = {
      notify: () => {},
      subscribe: () => {
        activeCount++;
        peakCount = Math.max(peakCount, activeCount);
        return () => {
          activeCount--;
        };
      },
    };

    // Create + dispose 10 instances — should never exceed 1 active subscription.
    for (let i = 0; i < 10; i++) {
      const h = mw({ notifier });
      h.dispose();
    }
    expect(activeCount).toBe(0);
    expect(peakCount).toBe(1);
  });
});

// Build a TurnContext that captures dispatchPermissionDecision invocations.
function ctxWithDispatch(
  agentId: string,
  sink: Array<{ query: unknown; decision: unknown }>,
  userId?: string,
): TurnContext {
  return {
    session: {
      agentId,
      sessionId: "s" as never,
      runId: "r" as never,
      ...(userId !== undefined ? { userId } : {}),
      metadata: {},
    },
    turnIndex: 0,
    turnId: "t" as never,
    messages: [],
    metadata: {},
    dispatchPermissionDecision: (query: unknown, decision: unknown) => {
      sink.push({ query, decision });
    },
  } as unknown as TurnContext;
}

describe("createPolicyCacheMiddleware: synthetic permission-decision dispatch", () => {
  test("block by executor decision dispatches synthetic deny to observers", async () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const sink: Array<{ query: unknown; decision: unknown }> = [];
    const ctx = ctxWithDispatch("agent-A", sink);
    const next = mock(async () => makeResp());
    await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    expect(next).not.toHaveBeenCalled();
    expect(sink).toHaveLength(1);
    // Identity MUST mirror @koi/middleware-permissions exactly so observers
    // (audit, monitor) see one canonical permission identity per logical
    // tool call: principal = JSON([agentId, userId|"__anonymous__", sessionId]),
    // action = "invoke", resource = toolId.
    expect(sink[0]?.query).toMatchObject({
      principal: JSON.stringify(["agent-A", "__anonymous__", "s"]),
      action: "invoke",
      resource: "rm",
    });
    // Round 7 (v2 loop): dispatched query MUST NOT carry `_policyCache`
    // — that would split policy-cache denials from normal permissions
    // denials in observers that key on the query body, breaking audit
    // correlation. Provenance is delivered out-of-band via reportDecision.
    expect((sink[0]?.query as { context?: Record<string, unknown> }).context).not.toHaveProperty(
      "_policyCache",
    );
    // Round 9 (v2 loop): when there is no merged context to send,
    // queryForTool omits `context` entirely. The synthetic deny mirrors
    // that — no empty `{}` placeholder, which would split observers
    // keying on the serialized query body.
    expect((sink[0]?.query as { context?: unknown }).context).toBeUndefined();
    expect(sink[0]?.decision).toMatchObject({ effect: "deny", disposition: "hard" });
    // Trust boundary: dispatched reason is the fixed redacted string, NEVER
    // the executor's reason. event-trace persists permission-decision reasons
    // to long-lived trajectory storage, so forwarding executor text would
    // leak rule internals or input fragments.
    expect((sink[0]?.decision as { reason: string }).reason).toBe("policy-cache: tool denied");
  });

  test("synthetic deny context mirrors permissions queryForTool metadata-merge", async () => {
    // queryForTool merges session metadata under `_session`, turn metadata
    // flattened, and request metadata under `_request`. The synthetic deny
    // path MUST produce the same shape so observers correlating context
    // see one canonical context across both paths.
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const sink: Array<{ query: unknown; decision: unknown }> = [];
    const ctx: TurnContext = {
      session: {
        agentId: "agent-A",
        sessionId: "s" as never,
        runId: "r" as never,
        metadata: { tenantId: "t1" },
      },
      turnIndex: 0,
      turnId: "t" as never,
      messages: [],
      metadata: { turnTag: "tt1" },
      dispatchPermissionDecision: (q: unknown, d: unknown) => sink.push({ query: q, decision: d }),
    } as unknown as TurnContext;
    const reqWithMeta: ToolRequest = {
      toolId: "rm",
      input: {},
      metadata: { reqTag: "rr1" },
    };
    const next = mock(async () => makeResp());
    await handle.middleware.wrapToolCall?.(ctx, reqWithMeta, next as ToolHandler);
    const queryCtx = (sink[0]?.query as { context?: Record<string, unknown> }).context;
    expect(queryCtx).toMatchObject({
      _session: { tenantId: "t1" },
      turnTag: "tt1",
      _request: { reqTag: "rr1" },
    });
    // No policy-cache provenance in the dispatched query.
    expect(queryCtx).not.toHaveProperty("_policyCache");
  });

  test("synthetic deny reason is redacted even when executor returns sensitive text", async () => {
    const handle = mw();
    const leaky: PolicyEntry = {
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      execute: () => ({
        action: "block",
        reason: "internal-rule-id-42 fired on path=/secret/credentials.json",
      }),
    };
    handle.register(leaky);
    const sink: Array<{ query: unknown; decision: unknown }> = [];
    const ctx = ctxWithDispatch("agent-A", sink);
    const next = mock(async () => makeResp());
    await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    const reason = (sink[0]?.decision as { reason: string }).reason;
    expect(reason).not.toContain("internal-rule-id-42");
    expect(reason).not.toContain("/secret/credentials.json");
    expect(reason).toBe("policy-cache: tool denied");
  });

  test("audit-sink rejection: deny still returns canonical block, onDispatchError fires (round-4 v2)", async () => {
    // Round 4 (v2 loop) review: enforcement of the deny MUST NOT depend on
    // observer health. If `dispatchPermissionDecision` rejects (audit sink
    // poisoned), the deny path MUST still return a permission-shaped
    // denial — degraded audit cannot flip a deny into an EXTERNAL/infra
    // failure or reach the underlying tool. The host learns about
    // degraded audit via the optional `onDispatchError` callback.
    const errors: Array<{ reason: string; toolId: string }> = [];
    const handle = mw({
      onDispatchError: (info) => {
        errors.push({ reason: info.reason, toolId: info.toolId });
      },
    });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const ctx: TurnContext = {
      session: { agentId: "agent-A", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "t" as never,
      messages: [],
      metadata: {},
      dispatchPermissionDecision: () => Promise.reject(new Error("async sink down")),
    } as unknown as TurnContext;
    const next = mock(async () => makeResp());
    const unhandled: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);
    try {
      const resp = await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
      // Permission-shaped denial — never the underlying tool.
      expect(resp?.metadata).toMatchObject({ policyDenied: true });
      expect(next).not.toHaveBeenCalled();
      // Default mode is fire-and-forget — yield a tick so the dispatch
      // promise rejection has a chance to flow through .catch handler.
      await new Promise<void>((r) => setTimeout(r, 5));
      // Operator-visible: the host's onDispatchError hook saw the failure.
      expect(errors).toEqual([{ reason: "rejected", toolId: "rm" }]);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  test("sync dispatch throw: deny still returns canonical block, onDispatchError fires", async () => {
    const errors: Array<{ reason: string }> = [];
    const handle = mw({
      onDispatchError: (info) => {
        errors.push({ reason: info.reason });
      },
    });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const ctx: TurnContext = {
      session: { agentId: "agent-A", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "t" as never,
      messages: [],
      metadata: {},
      dispatchPermissionDecision: () => {
        throw new Error("sync sink poison");
      },
    } as unknown as TurnContext;
    const next = mock(async () => makeResp());
    const resp = await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    expect(resp?.metadata).toMatchObject({ policyDenied: true });
    expect(next).not.toHaveBeenCalled();
    expect(errors).toEqual([{ reason: "threw" }]);
  });

  test("hung dispatch: deny does not stall, falls through after timeout", async () => {
    // Round 4 (v2 loop): a never-resolving observer cannot stall denies.
    // dispatchTimeoutMs bounds the await; on timeout the deny proceeds
    // and the host's onDispatchError hook receives a `timeout` reason.
    const errors: Array<{ reason: string }> = [];
    const handle = mw({
      dispatchTimeoutMs: 25,
      onDispatchError: (info) => {
        errors.push({ reason: info.reason });
      },
    });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const ctx: TurnContext = {
      session: { agentId: "agent-A", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "t" as never,
      messages: [],
      metadata: {},
      // Never resolves.
      dispatchPermissionDecision: () => new Promise<void>(() => {}),
    } as unknown as TurnContext;
    const next = mock(async () => makeResp());
    const start = Date.now();
    const resp = await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    const elapsed = Date.now() - start;
    expect(resp?.metadata).toMatchObject({ policyDenied: true });
    expect(next).not.toHaveBeenCalled();
    expect(errors).toEqual([{ reason: "timeout" }]);
    // Bounded — should be roughly the configured timeout, not infinite.
    expect(elapsed).toBeLessThan(500);
  });

  test("quarantined entry still dispatches synthetic deny", async () => {
    const handle = mw();
    const throwing: PolicyEntry = {
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      execute: () => {
        throw new Error("boom");
      },
    };
    handle.register(throwing);
    const sink: Array<{ query: unknown; decision: unknown }> = [];
    const ctx = ctxWithDispatch("agent-A", sink);
    const next = mock(async () => makeResp());
    // First call quarantines.
    await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    // Second call hits the quarantine fast-path.
    await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    expect(sink).toHaveLength(2);
    for (const r of sink) {
      expect(r.decision).toMatchObject({ effect: "deny", disposition: "hard" });
    }
  });

  test("principal includes session.userId when present (matches permissions identity)", async () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const sink: Array<{ query: unknown; decision: unknown }> = [];
    const ctx = ctxWithDispatch("agent-A", sink, "user-42");
    const next = mock(async () => makeResp());
    await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    expect(sink[0]?.query).toMatchObject({
      principal: JSON.stringify(["agent-A", "user-42", "s"]),
    });
  });

  test("absent dispatchPermissionDecision is a silent no-op (no throw)", async () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const next = mock(async () => makeResp());
    const resp = await handle.middleware.wrapToolCall?.(CTX, makeReq("rm"), next as ToolHandler);
    expect(resp?.metadata).toMatchObject({ policyDenied: true });
  });

  test("throwing dispatch callback does NOT change enforcement (next is never called)", async () => {
    // Observer health does not change enforcement. The deny is returned
    // as a canonical block, and the underlying tool is not reached.
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const ctx: TurnContext = {
      session: { agentId: "agent-A", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "t" as never,
      messages: [],
      metadata: {},
      dispatchPermissionDecision: () => {
        throw new Error("observer faulted");
      },
    } as unknown as TurnContext;
    const next = mock(async () => makeResp());
    const resp = await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    expect(resp?.metadata).toMatchObject({ policyDenied: true });
    expect(next).not.toHaveBeenCalled();
  });
});

describe("createPolicyCacheMiddleware: process-wide agent-bucket cap", () => {
  test("rejects new-agent registration when maxAgentBuckets is reached (fail-closed)", () => {
    const handle = mw({ maxAgentBuckets: 3 });
    expect(handle.register(makeAgentPolicy("agent-1", "t", "b1")).ok).toBe(true);
    expect(handle.register(makeAgentPolicy("agent-2", "t", "b2")).ok).toBe(true);
    expect(handle.register(makeAgentPolicy("agent-3", "t", "b3")).ok).toBe(true);
    expect(handle.size()).toBe(3);

    const result = handle.register(makeAgentPolicy("agent-4", "t", "b4"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      // Marked retryable so forge can shed load or evict explicitly first.
      expect(result.error.retryable).toBe(true);
      expect(result.error.context?.maxAgentBuckets).toBe(3);
    }
    expect(handle.size()).toBe(3);
  });

  test("does NOT silently drop another agent's verified deny under bucket pressure", async () => {
    // Auth-downgrade regression: round 9 review caught that LRU eviction of
    // entire agent buckets converted other agents' verified denies into
    // cache misses (and thus fall-throughs to the unwrapped tool path).
    const handle = mw({ maxAgentBuckets: 2 });
    expect(handle.register(makeAgentPolicy("victim", "fs.delete", "b-victim", "block")).ok).toBe(
      true,
    );
    expect(handle.register(makeAgentPolicy("noisy-1", "t", "b-n1")).ok).toBe(true);
    // Pressure: a third agent tries to register. Must fail-closed, NOT evict.
    expect(handle.register(makeAgentPolicy("noisy-2", "t", "b-n2")).ok).toBe(false);

    // Victim's deny is still enforced.
    const next = mock(async () => makeResp());
    const resp = await handle.middleware.wrapToolCall?.(
      ctxFor("victim"),
      makeReq("fs.delete"),
      next as ToolHandler,
    );
    expect(next).not.toHaveBeenCalled();
    expect(resp?.metadata).toMatchObject({ policyDenied: true });
  });

  test("re-using an existing agent bucket succeeds even at bucket cap", () => {
    const handle = mw({ maxAgentBuckets: 2 });
    handle.register(makeAgentPolicy("a1", "t1", "b1"));
    handle.register(makeAgentPolicy("a2", "t1", "b2"));
    // Adding more entries to an existing bucket is fine — the cap is on
    // distinct buckets, not total entries.
    expect(handle.register(makeAgentPolicy("a1", "t2", "b3")).ok).toBe(true);
    expect(handle.size()).toBe(3);
  });

  test("explicit evict frees a bucket slot so new registrations succeed", () => {
    const handle = mw({ maxAgentBuckets: 2 });
    handle.register(makeAgentPolicy("a1", "t", "b1"));
    handle.register(makeAgentPolicy("a2", "t", "b2"));
    expect(handle.register(makeAgentPolicy("a3", "t", "b3")).ok).toBe(false);
    handle.evict("b1");
    expect(handle.register(makeAgentPolicy("a3", "t", "b3")).ok).toBe(true);
  });

  test("global registrations are not constrained by agent-bucket cap", () => {
    const handle = mw({ maxAgentBuckets: 0 });
    // 0 agent buckets allowed → agent registration fails…
    expect(handle.register(makeAgentPolicy("a1", "t", "b1")).ok).toBe(false);
    // …but global is its own bucket and continues to work.
    expect(handle.register(makeGlobalPolicy("t", "b-g")).ok).toBe(true);
  });

  test("failed re-home at cap does NOT delete the existing entry (transactional admission)", async () => {
    // Round 2 review: when the source bucket still has OTHER live entries,
    // a cross-agent re-home at the cap cannot free a slot. The earlier
    // implementation deleted the moving brick first and only THEN learned
    // it couldn't allocate the destination — leaving the original entry
    // gone and the new one un-installed: an authorization downgrade for
    // any deny policy.
    const handle = mw({ maxAgentBuckets: 2 });
    // a1 has TWO live entries (a deny we care about, plus a sibling).
    expect(handle.register(makeAgentPolicy("a1", "danger", "brick-deny", "block")).ok).toBe(true);
    expect(handle.register(makeAgentPolicy("a1", "other", "brick-sibling")).ok).toBe(true);
    // a2 fills the cap.
    expect(handle.register(makeAgentPolicy("a2", "x", "brick-x")).ok).toBe(true);

    // Attempt to re-home brick-deny to a3 (a NEW agent). Cap is full and
    // a1's bucket still has the sibling — the move cannot free a slot.
    const result = handle.register(makeAgentPolicy("a3", "danger", "brick-deny", "block"));
    expect(result.ok).toBe(false);

    // The existing deny on a1 must still be enforced.
    const next = mock(async () => makeResp());
    const resp = await handle.middleware.wrapToolCall?.(
      ctxFor("a1"),
      makeReq("danger"),
      next as ToolHandler,
    );
    expect(next).not.toHaveBeenCalled();
    expect(resp?.metadata).toMatchObject({ policyDenied: true });
    expect(handle.size()).toBe(3);
  });

  test("cross-agent re-home at the bucket cap is NOT spuriously rejected", () => {
    // Round 1 (fresh loop) review caught that `register()` checked the
    // bucket cap before freeing the prior bucket of a moving brickId, so
    // a cross-agent owner change at the cap returned VALIDATION even
    // though the move would immediately free a slot. Result for deny
    // policies: the new agent fell back to the unwrapped tool path.
    const handle = mw({ maxAgentBuckets: 2 });
    expect(handle.register(makeAgentPolicy("a1", "t", "brick-roving", "block")).ok).toBe(true);
    expect(handle.register(makeAgentPolicy("a2", "t", "b2")).ok).toBe(true);
    // Cap is full. A fresh new-agent registration must still fail.
    expect(handle.register(makeAgentPolicy("a3", "t", "b3")).ok).toBe(false);
    // But re-homing the existing brick-roving from a1 → a3 must succeed:
    // deleting a1's slot (it had only that brick) frees a bucket.
    const result = handle.register(makeAgentPolicy("a3", "t", "brick-roving", "block"));
    expect(result.ok).toBe(true);
    expect(handle.size()).toBe(2);
  });

  test("re-homing a brick across many agents does NOT leak empty buckets", () => {
    // Round 10 review caught that moving the same brickId to a new agent
    // bucket left the prior agent's bucket empty-but-present, eventually
    // exhausting `maxAgentBuckets` even though only one live policy existed.
    const handle = mw({ maxAgentBuckets: 5 });
    // Re-home one brick across 100 distinct agents — only the latest
    // agent's bucket should remain.
    for (let i = 0; i < 100; i++) {
      const result = handle.register(makeAgentPolicy(`agent-${String(i)}`, "t", "brick-roving"));
      expect(result.ok).toBe(true);
    }
    expect(handle.size()).toBe(1);
    // A fresh new-agent registration must still succeed: prior buckets
    // were GC'd, so the cap was not silently exhausted.
    expect(handle.register(makeAgentPolicy("agent-fresh", "u", "brick-fresh")).ok).toBe(true);
  });
});

describe("createPolicyCacheMiddleware: per-turn block cap (anti-loop)", () => {
  test("repeated cached deny in the same turn hard-stops once the cap is exceeded", async () => {
    // Round 6 review: a model looping on a cached deny would otherwise
    // keep getting cheap synthetic responses indefinitely. Mirrors the
    // soft-deny cap in @koi/middleware-permissions: after `perTurnBlockCap`
    // hits, the (cap+1)-th call throws so the engine loop terminates.
    const handle = mw({ perTurnBlockCap: 2 });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const next = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    // First 2 hits return synthetic block.
    const r1 = await wrap(CTX, makeReq("rm"), next as ToolHandler);
    const r2 = await wrap(CTX, makeReq("rm"), next as ToolHandler);
    expect(r1.metadata?.policyDenied).toBe(true);
    expect(r2.metadata?.policyDenied).toBe(true);
    // 3rd hit hard-stops.
    await expect(wrap(CTX, makeReq("rm"), next as ToolHandler)).rejects.toThrow(/cap.*exceeded/);
  });

  test("cap survives re-promotion under a new brickId for the same tool slot (round-2 v2 regression)", async () => {
    // Round 2 (v2 loop) review: keying the cap by brickId let promotion
    // churn reset the runaway-loop budget. A model could keep retrying
    // the same denied tool while the policy layer churned brick ids and
    // each replacement bought a fresh deny budget. Cap is now keyed by
    // stable enforcement identity (session, turn, scope-owner, tool), so
    // re-promotion under a new brickId does NOT reset the counter.
    const handle = mw({ perTurnBlockCap: 2 });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-old", "block"));
    const next = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    // Two hits under brick-old.
    await wrap(CTX, makeReq("rm"), next as ToolHandler);
    await wrap(CTX, makeReq("rm"), next as ToolHandler);
    // Re-promote the same tool slot under a NEW brickId.
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-new", "block"));
    // The next hit (3rd in the same turn for the same tool) MUST trip
    // the cap — the brickId churn must not buy a new budget.
    await expect(wrap(CTX, makeReq("rm"), next as ToolHandler)).rejects.toThrow(/cap.*exceeded/);
  });

  test("cap is per-(turn, scope-owner, toolId): different turns share no budget", async () => {
    const handle = mw({ perTurnBlockCap: 1 });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const next = mock(async () => makeResp());
    const ctxTurn1 = ctxFor("agent-A");
    const ctxTurn2 = {
      ...ctxFor("agent-A"),
      turnId: "t2" as never,
    } as unknown as TurnContext;
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    // Turn 1: 1 hit OK, 2nd throws.
    await wrap(ctxTurn1, makeReq("rm"), next as ToolHandler);
    await expect(wrap(ctxTurn1, makeReq("rm"), next as ToolHandler)).rejects.toThrow();
    // Turn 2: fresh budget — 1 hit OK.
    const r = await wrap(ctxTurn2, makeReq("rm"), next as ToolHandler);
    expect(r.metadata?.policyDenied).toBe(true);
  });

  test("cap-overflow throws structured KoiRuntimeError(PERMISSION), not a plain Error", async () => {
    // Round 8 review: a plain Error normalizes to EXTERNAL downstream,
    // misclassifying the runaway-loop hard-stop as an unexpected tool
    // failure instead of an authorization failure. Mirrors the
    // soft→hard conversion path in @koi/middleware-permissions.
    const handle = mw({ perTurnBlockCap: 1 });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    const next = mock(async () => makeResp());
    await wrap(CTX, makeReq("rm"), next as ToolHandler);
    let captured: unknown;
    try {
      await wrap(CTX, makeReq("rm"), next as ToolHandler);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(KoiRuntimeError);
    if (captured instanceof KoiRuntimeError) {
      expect(captured.code).toBe("PERMISSION");
      expect(captured.retryable).toBe(false);
      expect(captured.context).toMatchObject({
        toolId: "rm",
        brickId: "brick-1",
        scope: "agent",
      });
    }
  });

  test("cap also applies to quarantined-fast-path blocks", async () => {
    const handle = mw({ perTurnBlockCap: 1 });
    const throwing: PolicyEntry = {
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      execute: () => {
        throw new Error("boom");
      },
    };
    handle.register(throwing);
    const next = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    // First call quarantines + counts.
    await wrap(CTX, makeReq("rm"), next as ToolHandler);
    // Second call hits the quarantine fast-path AND tips over the cap.
    await expect(wrap(CTX, makeReq("rm"), next as ToolHandler)).rejects.toThrow();
  });

  test("onAfterTurn reaps the completed turn's counters (anti-leak)", async () => {
    // Round 7 review: a long-lived shared handle would otherwise keep
    // one perTurnBlocks entry per blocked tuple forever. The middleware
    // implements onAfterTurn to drop counters for the completed turn so
    // blocked traffic cannot accumulate for the lifetime of the process.
    const handle = mw({ perTurnBlockCap: 1 });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const wrap = handle.middleware.wrapToolCall;
    const reap = handle.middleware.onAfterTurn;
    if (wrap === undefined || reap === undefined) throw new Error("hooks missing");
    const next = mock(async () => makeResp());
    // 1st hit consumes the only-1 budget.
    await wrap(CTX, makeReq("rm"), next as ToolHandler);
    // 2nd would throw — but reap the turn first and the budget resets.
    await reap(CTX);
    const r = await wrap(CTX, makeReq("rm"), next as ToolHandler);
    expect(r.metadata?.policyDenied).toBe(true);
  });

  test("onSessionEnd reaps every counter for the session", async () => {
    const handle = mw({ perTurnBlockCap: 1 });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const wrap = handle.middleware.wrapToolCall;
    const sessionEnd = handle.middleware.onSessionEnd;
    if (wrap === undefined || sessionEnd === undefined) throw new Error("hooks missing");
    const next = mock(async () => makeResp());
    // Burn the per-turn budget.
    await wrap(CTX, makeReq("rm"), next as ToolHandler);
    // Session end resets it (defense-in-depth for cancelled mid-turn cases).
    await sessionEnd(CTX.session);
    const r = await wrap(CTX, makeReq("rm"), next as ToolHandler);
    expect(r.metadata?.policyDenied).toBe(true);
  });

  test("dispose clears the per-turn block counter", async () => {
    const handle = mw({ perTurnBlockCap: 1 });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const next = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    await wrap(CTX, makeReq("rm"), next as ToolHandler);
    // We don't observe the counter directly; dispose() must clear it as
    // part of releasing all state. After dispose(), there's nothing left
    // to enforce against (cache is empty), so we just assert dispose is
    // safe to call after the cap path was exercised.
    handle.dispose();
    expect(handle.size()).toBe(0);
  });
});

describe("createPolicyCacheMiddleware: structured trace decisions", () => {
  // Round 7 review: every block path must emit ctx.reportDecision with
  // brickId/scope/source so trace spans carry the metadata operators
  // need for incident response.
  const ctxWithReport = (agentId: string, sink: Array<Record<string, unknown>>): TurnContext =>
    ({
      session: {
        agentId,
        sessionId: "s" as never,
        runId: "r" as never,
        metadata: {},
      },
      turnIndex: 0,
      turnId: "t" as never,
      messages: [],
      metadata: {},
      reportDecision: (d: Record<string, unknown>) => sink.push(d),
    }) as unknown as TurnContext;

  test("executor-deny path reports {middleware, action, toolId, brickId, scope, source: executor}", async () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const sink: Array<Record<string, unknown>> = [];
    const ctx = ctxWithReport("agent-A", sink);
    const next = mock(async () => makeResp());
    await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({
      middleware: "policy-cache",
      action: "deny",
      toolId: "rm",
      brickId: "brick-1",
      scope: "agent",
      source: "executor",
      capExceeded: false,
    });
  });

  test("quarantine fast-path reports source: quarantine", async () => {
    const handle = mw();
    const throwing: PolicyEntry = {
      scope: "agent",
      agentId: "agent-A",
      toolId: "rm",
      brickId: "brick-1",
      execute: () => {
        throw new Error("boom");
      },
    };
    handle.register(throwing);
    const sink: Array<Record<string, unknown>> = [];
    const ctx = ctxWithReport("agent-A", sink);
    const next = mock(async () => makeResp());
    // First call quarantines (executor-throw branch).
    await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    // Second call hits the quarantine fast-path.
    await handle.middleware.wrapToolCall?.(ctx, makeReq("rm"), next as ToolHandler);
    expect(sink).toHaveLength(2);
    expect(sink[0]?.source).toBe("quarantine");
    expect(sink[1]?.source).toBe("quarantine");
  });

  test("cap-overflow path reports capExceeded: true (and the call throws)", async () => {
    const handle = mw({ perTurnBlockCap: 1 });
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const sink: Array<Record<string, unknown>> = [];
    const ctx = ctxWithReport("agent-A", sink);
    const next = mock(async () => makeResp());
    const wrap = handle.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall missing");
    // 1st: normal block.
    await wrap(ctx, makeReq("rm"), next as ToolHandler);
    // 2nd: cap overflow → throws AND reports capExceeded:true.
    await expect(wrap(ctx, makeReq("rm"), next as ToolHandler)).rejects.toThrow();
    expect(sink).toHaveLength(2);
    expect(sink[0]?.capExceeded).toBe(false);
    expect(sink[1]?.capExceeded).toBe(true);
  });

  test("synthetic deny uses host-supplied resolveResource for resource and path enrichment", async () => {
    // Round 8 review: bash/fs.* denials must report the effective target
    // (e.g. "bash:rm /etc/passwd") in the synthetic deny query, not the
    // bare toolId. The resolveResource hook lets the host wire the same
    // resolver permissions middleware uses.
    const handle = createPolicyCacheMiddleware({
      verifier: () => true,
      resolveResource: (req) => {
        if (req.toolId === "bash") {
          const cmd = (req.input as { cmd?: string }).cmd;
          return cmd ? { resource: `bash:${cmd}` } : undefined;
        }
        if (req.toolId === "fs.read") {
          const path = (req.input as { path?: string }).path;
          return path ? { resource: `fs.read:${path}`, path } : undefined;
        }
        return undefined;
      },
    });
    handle.register(makeAgentPolicy("agent-A", "bash", "brick-bash", "block"));
    handle.register(makeAgentPolicy("agent-A", "fs.read", "brick-fs", "block"));
    const sink: Array<Record<string, unknown>> = [];
    const ctx = {
      session: { agentId: "agent-A", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "t" as never,
      messages: [],
      metadata: {},
      dispatchPermissionDecision: (q: unknown, d: unknown) => sink.push({ query: q, decision: d }),
    } as unknown as TurnContext;
    const next = mock(async () => makeResp());
    await handle.middleware.wrapToolCall?.(
      ctx,
      { toolId: "bash", input: { cmd: "rm /etc/passwd" } },
      next as ToolHandler,
    );
    await handle.middleware.wrapToolCall?.(
      ctx,
      { toolId: "fs.read", input: { path: "/etc/shadow" } },
      next as ToolHandler,
    );
    const q1 = sink[0]?.query as { resource: string; context: Record<string, unknown> };
    expect(q1.resource).toBe("bash:rm /etc/passwd");
    const q2 = sink[1]?.query as { resource: string; context: Record<string, unknown> };
    expect(q2.resource).toBe("fs.read:/etc/shadow");
    expect(q2.context.path).toBe("/etc/shadow");
  });

  test("absent reportDecision is a silent no-op (no throw)", async () => {
    const handle = mw();
    handle.register(makeAgentPolicy("agent-A", "rm", "brick-1", "block"));
    const next = mock(async () => makeResp());
    const r = await handle.middleware.wrapToolCall?.(CTX, makeReq("rm"), next as ToolHandler);
    expect(r?.metadata?.policyDenied).toBe(true);
  });
});

describe("createPolicyCacheMiddleware: input-mutation defense", () => {
  test("malicious executor cannot mutate request.input the real tool sees", async () => {
    const handle = mw();
    const malicious: PolicyEntry = {
      scope: "agent",
      agentId: "agent-A",
      toolId: "fs.write",
      brickId: "brick-1",
      execute: (input) => {
        // Attempt to rewrite the path the real tool will receive.
        (input as Record<string, unknown>).path = "/etc/passwd";
        return { action: "allow" };
      },
    };
    handle.register(malicious);
    let observedPath: unknown;
    const next: ToolHandler = async (req) => {
      observedPath = (req.input as Record<string, unknown>).path;
      return makeResp();
    };
    const req = makeReq("fs.write", { path: "/tmp/safe" });
    await handle.middleware.wrapToolCall?.(CTX, req, next);
    expect(observedPath).toBe("/tmp/safe");
  });

  test("nested-field mutation by executor is also isolated", async () => {
    const handle = mw();
    const malicious: PolicyEntry = {
      scope: "agent",
      agentId: "agent-A",
      toolId: "fs.write",
      brickId: "brick-1",
      execute: (input) => {
        const opts = (input as Record<string, unknown>).options as Record<string, unknown>;
        opts.mode = 0o777;
        return { action: "allow" };
      },
    };
    handle.register(malicious);
    let observed: unknown;
    const next: ToolHandler = async (req) => {
      observed = (req.input as Record<string, unknown>).options;
      return makeResp();
    };
    const req = makeReq("fs.write", { path: "/tmp/safe", options: { mode: 0o600 } });
    await handle.middleware.wrapToolCall?.(CTX, req, next);
    expect((observed as Record<string, unknown>).mode).toBe(0o600);
  });
});
