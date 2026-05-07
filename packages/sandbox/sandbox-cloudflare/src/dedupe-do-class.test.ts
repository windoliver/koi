import { beforeEach, describe, expect, it } from "bun:test";

import { KoiDedupeDO } from "./dedupe-do-class.js";
import { createMockDoStorage, type MockStorageHandle } from "./dedupe-do-mock-storage.js";
import type { ClaimRequest, DedupeDoClock } from "./dedupe-do-types.js";

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

const makeFakeClock = (
  initial: number,
): DedupeDoClock & { advance: (ms: number) => void; set: (n: number) => void } => {
  let now = initial;
  return {
    nowMs: () => now,
    advance: (ms) => {
      now += ms;
    },
    set: (n) => {
      now = n;
    },
  };
};

const claimReq = (overrides: Partial<ClaimRequest> = {}): ClaimRequest => ({
  operationId: "op-1",
  requestId: "req-1",
  dedupeFingerprint: FP_A,
  dedupeExpiresAtMs: 1_000_000 + 60_000,
  ...overrides,
});

let storage: MockStorageHandle;
let clock: ReturnType<typeof makeFakeClock>;
let doInst: KoiDedupeDO;

beforeEach(() => {
  storage = createMockDoStorage();
  clock = makeFakeClock(1_000_000);
  doInst = new KoiDedupeDO({ storage, clock, config: { leaseDurationMs: 15_000 } });
});

describe("KoiDedupeDO — claim transitions", () => {
  it("returns 'fresh' for the first claim and writes ledger + claim atomically", async () => {
    const r = await doInst.claim(claimReq());
    expect(r.status).toBe("fresh");
    const dump = storage.debugDump();
    expect(dump.has("ledger")).toBe(true);
    expect(dump.has("claim")).toBe(true);
    expect(dump.has("terminal")).toBe(false);
  });

  it("returns 'in-progress' to a second isolate while the first holds the lease", async () => {
    await doInst.claim(claimReq({ requestId: "req-1" }));
    const r = await doInst.claim(claimReq({ requestId: "req-2" }));
    expect(r.status).toBe("in-progress");
    if (r.status !== "in-progress") return;
    expect(r.claimer).toBe("req-1");
  });

  it("transitions to a new claimer once the lease expires", async () => {
    await doInst.claim(claimReq({ requestId: "req-1" }));
    clock.advance(20_000);
    const r = await doInst.claim(claimReq({ requestId: "req-2" }));
    expect(r.status).toBe("fresh");
  });

  it("returns 'fingerprint-conflict' when operationId is reused with a different payload", async () => {
    await doInst.claim(claimReq({ dedupeFingerprint: FP_A }));
    const r = await doInst.claim(claimReq({ requestId: "req-2", dedupeFingerprint: FP_B }));
    expect(r.status).toBe("fingerprint-conflict");
    if (r.status !== "fingerprint-conflict") return;
    expect(r.storedFingerprint).toBe(FP_A);
  });

  it("returns 'fingerprint-conflict' EXPIRY_HORIZON_MISMATCH on shifted dedupeExpiresAtMs", async () => {
    await doInst.claim(claimReq({ dedupeExpiresAtMs: 1_000_000 + 60_000 }));
    const r = await doInst.claim(
      claimReq({ requestId: "req-2", dedupeExpiresAtMs: 1_000_000 + 600_000 }),
    );
    expect(r.status).toBe("fingerprint-conflict");
    if (r.status !== "fingerprint-conflict") return;
    expect(r.storedFingerprint).toBe("EXPIRY_HORIZON_MISMATCH");
  });

  it("rejects horizons beyond the 30-day cap with INVALID_DEDUPE_HORIZON", async () => {
    const r = await doInst.claim(
      claimReq({ dedupeExpiresAtMs: clock.nowMs() + 31 * 24 * 60 * 60 * 1_000 }),
    );
    expect(r.status).toBe("fingerprint-conflict");
    if (r.status !== "fingerprint-conflict") return;
    expect(r.storedFingerprint).toBe("INVALID_DEDUPE_HORIZON");
  });
});

describe("KoiDedupeDO — completion paths", () => {
  it("commit succeeds for the lease holder and produces a 'completed' result on retry", async () => {
    await doInst.claim(claimReq({ requestId: "req-1" }));
    const c = await doInst.complete({
      operationId: "op-1",
      requestId: "req-1",
      dedupeFingerprint: FP_A,
      result: { hello: "world" },
      statusCode: 200,
      ttlExpiresAtMs: 1_000_000 + 60_000 + 3_600_000,
    });
    expect(c.committed).toBe(true);
    const r = await doInst.claim(claimReq({ requestId: "req-2" }));
    expect(r.status).toBe("completed");
    if (r.status !== "completed") return;
    expect(r.result).toEqual({ hello: "world" });
  });

  it("commit by a non-owner returns committed:false / OWNERSHIP_LOST", async () => {
    await doInst.claim(claimReq({ requestId: "req-1" }));
    const c = await doInst.complete({
      operationId: "op-1",
      requestId: "req-2",
      dedupeFingerprint: FP_A,
      result: 1,
      statusCode: 200,
      ttlExpiresAtMs: 1_000_000 + 60_000 + 3_600_000,
    });
    expect(c.committed).toBe(false);
    expect(c.reason).toBe("OWNERSHIP_LOST");
  });

  it("commit with mismatched fingerprint returns committed:false / FINGERPRINT_MISMATCH", async () => {
    await doInst.claim(claimReq({ requestId: "req-1", dedupeFingerprint: FP_A }));
    const c = await doInst.complete({
      operationId: "op-1",
      requestId: "req-1",
      dedupeFingerprint: FP_B,
      result: 1,
      statusCode: 200,
      ttlExpiresAtMs: 1_000_000 + 60_000 + 3_600_000,
    });
    expect(c.committed).toBe(false);
    expect(c.reason).toBe("FINGERPRINT_MISMATCH");
  });

  it("fail commits a failed-permanent record observable to retries", async () => {
    await doInst.claim(claimReq({ requestId: "req-1" }));
    const f = await doInst.fail({
      operationId: "op-1",
      requestId: "req-1",
      dedupeFingerprint: FP_A,
      error: "validation failed",
      ttlExpiresAtMs: 1_000_000 + 60_000 + 3_600_000,
    });
    expect(f.committed).toBe(true);
    const r = await doInst.claim(claimReq({ requestId: "req-2" }));
    expect(r.status).toBe("failed-permanent");
    if (r.status !== "failed-permanent") return;
    expect(r.error).toBe("validation failed");
  });
});

describe("KoiDedupeDO — hard-cutoff post-expiry", () => {
  it("returns 'operation-expired' on retry past originalDedupeExpiresAtMs even if a result is cached", async () => {
    await doInst.claim(claimReq({ requestId: "req-1", dedupeExpiresAtMs: 1_000_000 + 100 }));
    await doInst.complete({
      operationId: "op-1",
      requestId: "req-1",
      dedupeFingerprint: FP_A,
      result: "V1",
      statusCode: 200,
      ttlExpiresAtMs: 1_000_000 + 100 + 3_600_000,
    });

    clock.advance(200);
    const r = await doInst.claim(
      claimReq({ requestId: "req-2", dedupeExpiresAtMs: 1_000_000 + 100 }),
    );
    expect(r.status).toBe("operation-expired");
  });

  it("ledger row outlives result purge — post-expiry retry still returns operation-expired", async () => {
    await doInst.claim(claimReq({ dedupeExpiresAtMs: 1_000_000 + 100 }));
    await doInst.complete({
      operationId: "op-1",
      requestId: "req-1",
      dedupeFingerprint: FP_A,
      result: "V1",
      statusCode: 200,
      ttlExpiresAtMs: 1_000_000 + 100 + 1_000,
    });
    // Advance past the result TTL but well within the 30-day ledger horizon.
    clock.advance(2_000);
    await doInst.alarm();
    const dump = storage.debugDump();
    expect(dump.has("terminal")).toBe(false);
    expect(dump.has("ledger")).toBe(true);

    const r = await doInst.claim(
      claimReq({ requestId: "req-2", dedupeExpiresAtMs: 1_000_000 + 100 }),
    );
    expect(r.status).toBe("operation-expired");
  });
});

describe("KoiDedupeDO — alarm-driven two-phase purge", () => {
  it("phase 1 (terminal TTL) deletes the result while preserving the ledger", async () => {
    await doInst.claim(claimReq({ dedupeExpiresAtMs: 1_000_000 + 1_000 }));
    await doInst.complete({
      operationId: "op-1",
      requestId: "req-1",
      dedupeFingerprint: FP_A,
      result: "v",
      statusCode: 200,
      ttlExpiresAtMs: 1_000_000 + 2_000,
    });
    clock.advance(3_000);
    await doInst.alarm();
    const dump = storage.debugDump();
    expect(dump.has("terminal")).toBe(false);
    expect(dump.has("ledger")).toBe(true);
  });

  it("phase 2 (ledger expiry) deletes the ledger after its retention", async () => {
    await doInst.claim(claimReq({ dedupeExpiresAtMs: 1_000_000 + 1_000 }));
    // Jump past 30 days + 1 hour grace.
    clock.advance(31 * 24 * 60 * 60 * 1_000 + 60 * 60 * 1_000);
    await doInst.alarm();
    const dump = storage.debugDump();
    expect(dump.has("ledger")).toBe(false);
  });
});

describe("KoiDedupeDO — waitForTerminal", () => {
  it("returns 'completed' immediately when a terminal result is already present", async () => {
    await doInst.claim(claimReq({ requestId: "req-1" }));
    await doInst.complete({
      operationId: "op-1",
      requestId: "req-1",
      dedupeFingerprint: FP_A,
      result: "v",
      statusCode: 200,
      ttlExpiresAtMs: 1_000_000 + 60_000 + 3_600_000,
    });
    const w = await doInst.waitForTerminal({
      operationId: "op-1",
      requestId: "req-2",
      requestExpiryClaim: 1_000_000 + 60_000,
      timeoutMs: 1_000,
      pollIntervalMs: 10,
    });
    expect(w.kind).toBe("completed");
  });

  it("returns 'operation-id-conflict' when caller passes a shifted requestExpiryClaim", async () => {
    await doInst.claim(claimReq({ dedupeExpiresAtMs: 1_000_000 + 60_000 }));
    const w = await doInst.waitForTerminal({
      operationId: "op-1",
      requestId: "req-2",
      requestExpiryClaim: 1_000_000 + 600_000,
      timeoutMs: 100,
      pollIntervalMs: 10,
    });
    expect(w.kind).toBe("operation-id-conflict");
  });

  it("release() drops the claim for the owner and rejects non-owners", async () => {
    await doInst.claim(claimReq({ requestId: "owner" }));
    const wrongOwner = await doInst.release({ operationId: "op-1", requestId: "imposter" });
    expect(wrongOwner.released).toBe(false);
    expect(wrongOwner.reason).toBe("OWNERSHIP_LOST");
    const ok = await doInst.release({ operationId: "op-1", requestId: "owner" });
    expect(ok.released).toBe(true);
    // After release, next claim is fresh.
    const next = await doInst.claim(claimReq({ requestId: "next" }));
    expect(next.status).toBe("fresh");
  });

  it("returns 'claim-expired' when the original owner's lease elapsed without writing a terminal", async () => {
    // Inject a clock-advancing sleep so the loop progresses deterministically.
    const advancingSleep = async (ms: number): Promise<void> => {
      clock.advance(ms);
    };
    const local = new KoiDedupeDO({
      storage,
      clock,
      config: { leaseDurationMs: 15_000 },
      sleep: advancingSleep,
    });
    await local.claim(claimReq({ requestId: "owner-A" }));
    // Push the clock past the lease but well before the dedupe expiry — this
    // is the "owner crashed mid-flight" scenario.
    clock.advance(20_000);
    const w = await local.waitForTerminal({
      operationId: "op-1",
      requestId: "waiter-B",
      requestExpiryClaim: 1_000_000 + 60_000,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
    });
    expect(w.kind).toBe("claim-expired");
    if (w.kind !== "claim-expired") return;
    expect(w.previousClaimer).toBe("owner-A");
    // After takeover, the next claim() returns `fresh` so the waiter can
    // re-issue and become the new owner.
    const next = await local.claim(claimReq({ requestId: "waiter-B" }));
    expect(next.status).toBe("fresh");
  });

  it("returns 'timeout' if no terminal record arrives within timeoutMs", async () => {
    // Inject a clock-advancing sleep so the loop terminates deterministically
    // without depending on wall-clock time.
    const advancingSleep = async (ms: number): Promise<void> => {
      clock.advance(ms);
    };
    const local = new KoiDedupeDO({
      storage,
      clock,
      config: { leaseDurationMs: 15_000 },
      sleep: advancingSleep,
    });
    await local.claim(claimReq({ requestId: "req-1" }));
    const w = await local.waitForTerminal({
      operationId: "op-1",
      requestId: "req-2",
      requestExpiryClaim: 1_000_000 + 60_000,
      timeoutMs: 50,
      pollIntervalMs: 10,
    });
    expect(w.kind).toBe("timeout");
  });
});

describe("KoiDedupeDO — concurrent claim safety", () => {
  it("only one of N concurrent first-claims observes 'fresh'; the rest observe 'in-progress'", async () => {
    const reqs = Array.from({ length: 8 }, (_, i) =>
      doInst.claim(claimReq({ requestId: `req-${i}` })),
    );
    const results = await Promise.all(reqs);
    const fresh = results.filter((r) => r.status === "fresh");
    expect(fresh.length).toBe(1);
    const inProgress = results.filter((r) => r.status === "in-progress");
    expect(inProgress.length).toBe(results.length - 1);
  });
});
