import { describe, expect, it } from "bun:test";

import { createMockKv } from "./kv-mock.js";
import {
  type ClaimRequest,
  claim,
  commit,
  commitFail,
  extendLease,
  releaseTransient,
} from "./kv-state-machine.js";

const baseReq = (over: Partial<ClaimRequest> = {}): ClaimRequest => ({
  ownerId: "acme",
  operationId: "op-1",
  requestId: "req-1",
  dedupeFingerprint: "fp-1",
  dedupeExpiresAtMs: 10_000,
  nowMs: 1_000,
  resultRetentionSec: 3_600,
  ledgerRetentionSec: 86_400,
  ...over,
});

describe("kv-state-machine.claim", () => {
  it("returns fresh on the first claim", async () => {
    const kv = createMockKv();
    const r = await claim(kv, baseReq());
    expect(r.kind).toBe("fresh");
  });

  it("second claim with same requestId sees in-progress (lease holder)", async () => {
    const kv = createMockKv();
    await claim(kv, baseReq({ requestId: "req-A" }));
    const second = await claim(kv, baseReq({ requestId: "req-B" }));
    expect(second.kind).toBe("in-progress");
    if (second.kind !== "in-progress") return;
    expect(second.claimer).toBe("req-A");
  });

  it("returns fingerprint-conflict when fingerprint differs", async () => {
    const kv = createMockKv();
    await claim(kv, baseReq({ dedupeFingerprint: "fp-A" }));
    const r = await claim(kv, baseReq({ requestId: "req-2", dedupeFingerprint: "fp-B" }));
    expect(r.kind).toBe("fingerprint-conflict");
  });

  it("returns operation-expired past dedupeExpiresAtMs (no ledger)", async () => {
    const kv = createMockKv();
    const r = await claim(kv, baseReq({ nowMs: 99_999, dedupeExpiresAtMs: 10_000 }));
    expect(r.kind).toBe("operation-expired");
  });

  it("returns operation-expired past ledger expiry (with ledger)", async () => {
    const kv = createMockKv();
    await claim(kv, baseReq());
    const r = await claim(kv, baseReq({ requestId: "req-2", nowMs: 99_999 }));
    expect(r.kind).toBe("operation-expired");
  });

  it("returns completed after commit", async () => {
    const kv = createMockKv();
    await claim(kv, baseReq());
    const ok = await commit(kv, "acme", "op-1", "req-1", '{"hello":1}', 3_600);
    expect(ok).toBe(true);
    const r = await claim(kv, baseReq({ requestId: "req-2" }));
    expect(r.kind).toBe("completed");
    if (r.kind !== "completed") return;
    expect(r.result).toBe('{"hello":1}');
  });

  it("returns failed-permanent after commitFail", async () => {
    const kv = createMockKv();
    await claim(kv, baseReq());
    const ok = await commitFail(kv, "acme", "op-1", "req-1", '{"err":"x"}', 3_600);
    expect(ok).toBe(true);
    const r = await claim(kv, baseReq({ requestId: "req-2" }));
    expect(r.kind).toBe("failed-permanent");
  });

  it("rejects fingerprint mismatch with horizon skew beyond tolerance", async () => {
    const kv = createMockKv();
    await claim(kv, baseReq({ dedupeExpiresAtMs: 10_000 }));
    const r = await claim(
      kv,
      baseReq({ requestId: "req-2", dedupeExpiresAtMs: 10_000 + 5_000, skewToleranceMs: 1_000 }),
    );
    expect(r.kind).toBe("fingerprint-conflict");
  });

  it("concurrent first-claims: exactly one is fresh, others in-progress", async () => {
    const kv = createMockKv();
    const reqs = [...new Array(8)].map((_, i) => claim(kv, baseReq({ requestId: `r-${i}` })));
    const outcomes = await Promise.all(reqs);
    const fresh = outcomes.filter((o) => o.kind === "fresh").length;
    const inProgress = outcomes.filter((o) => o.kind === "in-progress").length;
    expect(fresh).toBe(1);
    expect(inProgress).toBe(7);
  });
});

describe("kv-state-machine.extendLease", () => {
  it("succeeds for the owning requestId", async () => {
    const kv = createMockKv();
    await claim(kv, baseReq());
    const ok = await extendLease(kv, "acme", "op-1", "req-1");
    expect(ok).toBe(true);
  });

  it("fails for a non-owner requestId", async () => {
    const kv = createMockKv();
    await claim(kv, baseReq());
    const ok = await extendLease(kv, "acme", "op-1", "wrong");
    expect(ok).toBe(false);
  });
});

describe("kv-state-machine.commit / commitFail / releaseTransient ownership", () => {
  it("commit fails for non-owner", async () => {
    const kv = createMockKv();
    await claim(kv, baseReq());
    const ok = await commit(kv, "acme", "op-1", "wrong", '"x"', 60);
    expect(ok).toBe(false);
  });

  it("commitFail fails for non-owner", async () => {
    const kv = createMockKv();
    await claim(kv, baseReq());
    const ok = await commitFail(kv, "acme", "op-1", "wrong", '"x"', 60);
    expect(ok).toBe(false);
  });

  it("releaseTransient drops the claim for the owner", async () => {
    const kv = createMockKv();
    await claim(kv, baseReq());
    const ok = await releaseTransient(kv, "acme", "op-1", "req-1");
    expect(ok).toBe(true);
    const next = await claim(kv, baseReq({ requestId: "req-2" }));
    expect(next.kind).toBe("fresh");
  });
});
