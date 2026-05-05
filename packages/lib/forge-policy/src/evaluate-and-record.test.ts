import { describe, expect, test } from "bun:test";
import { makeCandidate, makeConfig } from "./__tests__/fixtures.js";
import { createPolicyAuditLog } from "./audit.js";
import { evaluateAndRecord } from "./evaluate-and-record.js";

describe("evaluateAndRecord — atomic evaluate + record", () => {
  test("returns both the evaluation and the persisted audit entry", () => {
    const log = createPolicyAuditLog({ failClosedOnOverflowSinkError: false });
    const { evaluation, entry } = evaluateAndRecord({
      candidate: makeCandidate(),
      config: makeConfig(),
      evaluatedAt: 1_700_000_000_000,
      log,
    });
    expect(evaluation.verdict.decision).toBe("allow");
    expect(entry.candidateId).toBe(evaluation.candidateId);
    expect(entry.configFingerprint).toBe(evaluation.configFingerprint);
    expect(log.size()).toBe(1);
    expect(log.entries()[0]?.candidateId).toBe(entry.candidateId);
  });

  test("propagates fail-closed evaluations into the audit log without throwing", () => {
    const log = createPolicyAuditLog({ failClosedOnOverflowSinkError: false });
    type Cand = Parameters<typeof evaluateAndRecord>[0]["candidate"];
    const broken = { ...makeCandidate(), id: "" } as unknown as Cand;
    const { evaluation } = evaluateAndRecord({
      candidate: broken,
      config: makeConfig(),
      evaluatedAt: 1_700_000_000_000,
      log,
    });
    expect(evaluation.verdict.decision).toBe("deny");
    expect(evaluation.failureKind).toBe("candidate");
    expect(log.size()).toBe(1);
  });
});
