import { describe, expect, test } from "bun:test";
import type {
  BrickArtifact,
  ForgeDemandSignal,
  ForgeProvenance,
  ForgeVerificationSummary,
} from "@koi/core";
import { brickId, DEFAULT_FORGE_BUDGET, DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import type {
  ForgeArtifact,
  ForgeCandidate,
  ForgeDemand,
  ForgeEvent,
  ForgeLifecycleState,
  ForgeMiddlewareConfig,
  ForgePolicy,
  ForgePolicyVerdict,
  ForgeToolInput,
  ForgeToolResult,
} from "./types.js";
import {
  isFailableForgeStage,
  isForgeEvent,
  isForgeLifecycleState,
  isPublishedForgeLifecycleState,
  isTerminalForgeLifecycle,
} from "./types.js";

const sampleSignal: ForgeDemandSignal = {
  id: "sig-1",
  kind: "forge_demand",
  trigger: { kind: "no_matching_tool", query: "csv parse", attempts: 3 },
  confidence: 0.8,
  suggestedBrickKind: "tool",
  context: { failureCount: 3, failedToolCalls: ["fs.read"] },
  emittedAt: 1_700_000_000_000,
};

const sampleSummary: ForgeVerificationSummary = {
  passed: true,
  sandbox: true,
  totalDurationMs: 1234,
  stageResults: [{ stage: "static", passed: true, durationMs: 12 }],
};

const sampleProvenance: ForgeProvenance = {
  source: { origin: "forged", forgedBy: "agent-1" },
  buildDefinition: { buildType: "koi.forge.v1", externalParameters: {} },
  builder: { id: "koi/forge" },
  metadata: {
    invocationId: "inv-1",
    startedAt: 0,
    finishedAt: 1,
    sessionId: "sess",
    agentId: "agent-1",
    depth: 0,
  },
  verification: sampleSummary,
  classification: "internal",
  contentMarkers: [],
  contentHash: "sha256:abc",
};

const sampleBrick: BrickArtifact = {
  id: brickId("sha256:abc"),
  kind: "tool",
  name: "csv-parse",
  description: "Parse CSV",
  scope: "agent",
  origin: "forged",
  policy: DEFAULT_SANDBOXED_POLICY,
  lifecycle: "active",
  provenance: sampleProvenance,
  version: "1.0.0",
  tags: [],
  usageCount: 0,
  implementation: "export default () => {}",
  inputSchema: { type: "object" },
};

describe("@koi/forge-types — ForgeDemand", () => {
  test("ForgeDemand satisfies shape with status open", () => {
    const demand: ForgeDemand = {
      signal: sampleSignal,
      status: "open",
      observedAt: 1,
      occurrences: 1,
    };
    expect(demand.status).toBe("open");
    expect(demand.signal.id).toBe("sig-1");
    expect(demand.resolvedAt).toBeUndefined();
  });

  test("ForgeDemand with resolvedAt + accepted status", () => {
    const demand: ForgeDemand = {
      signal: sampleSignal,
      status: "accepted",
      observedAt: 1,
      resolvedAt: 2,
      occurrences: 5,
    };
    expect(demand.status).toBe("accepted");
    expect(demand.resolvedAt).toBe(2);
  });
});

describe("@koi/forge-types — ForgeCandidate", () => {
  test("ForgeCandidate satisfies shape", () => {
    const candidate: ForgeCandidate = {
      id: "cand-1",
      kind: "tool",
      name: "csv-parse",
      description: "Parse CSV",
      priority: 0.9,
      proposedScope: "agent",
      createdAt: 1,
    };
    expect(candidate.kind).toBe("tool");
    expect(candidate.demandId).toBeUndefined();
  });

  test("ForgeCandidate with demandId", () => {
    const candidate: ForgeCandidate = {
      id: "cand-2",
      kind: "skill",
      name: "summarize",
      description: "Summarize text",
      demandId: "demand-1",
      priority: 0.5,
      proposedScope: "zone",
      createdAt: 0,
    };
    expect(candidate.demandId).toBe("demand-1");
  });
});

describe("@koi/forge-types — ForgeArtifact", () => {
  test("ForgeArtifact wraps BrickArtifact + summary", () => {
    const artifact: ForgeArtifact = {
      brick: sampleBrick,
      candidateId: "cand-1",
      lifecycle: "published",
      verification: sampleSummary,
      forgedAt: 1,
      forgedBy: "agent-1",
    };
    expect(artifact.brick.id).toBe(sampleBrick.id);
    expect(artifact.verification.passed).toBe(true);
    expect(artifact.lifecycle).toBe("published");
  });
});

describe("@koi/forge-types — ForgePolicy + verdicts", () => {
  test("ForgePolicy satisfies shape", () => {
    const policy: ForgePolicy = {
      allowedKinds: ["tool", "skill"],
      maxScope: "zone",
      budget: DEFAULT_FORGE_BUDGET,
      requireApprovalAtOrAbove: "global",
    };
    expect(policy.allowedKinds).toContain("tool");
    expect(policy.budget.maxForgesPerSession).toBe(DEFAULT_FORGE_BUDGET.maxForgesPerSession);
  });

  test("ForgePolicyVerdict allow", () => {
    const v: ForgePolicyVerdict = { decision: "allow" };
    expect(v.decision).toBe("allow");
  });

  test("ForgePolicyVerdict require-approval narrows correctly", () => {
    const v: ForgePolicyVerdict = {
      decision: "require-approval",
      reason: "scope > zone",
    };
    if (v.decision === "require-approval") {
      expect(v.reason).toBe("scope > zone");
    } else {
      throw new Error("expected require-approval");
    }
  });

  test("ForgePolicyVerdict deny narrows correctly", () => {
    const v: ForgePolicyVerdict = { decision: "deny", reason: "kind not allowed" };
    if (v.decision === "deny") {
      expect(v.reason).toBe("kind not allowed");
    } else {
      throw new Error("expected deny");
    }
  });
});

describe("@koi/forge-types — ForgeLifecycleState guards", () => {
  test("isForgeLifecycleState accepts every valid state", () => {
    const states: ForgeLifecycleState[] = [
      "detected",
      "proposed",
      "synthesizing",
      "verifying",
      "published",
      "failed",
      "retired",
    ];
    for (const s of states) {
      expect(isForgeLifecycleState(s)).toBe(true);
    }
  });

  test("isForgeLifecycleState rejects unknown values", () => {
    expect(isForgeLifecycleState("active")).toBe(false);
    expect(isForgeLifecycleState("")).toBe(false);
    expect(isForgeLifecycleState("PUBLISHED")).toBe(false);
  });

  test("isFailableForgeStage accepts only pre-publication stages", () => {
    expect(isFailableForgeStage("detected")).toBe(true);
    expect(isFailableForgeStage("proposed")).toBe(true);
    expect(isFailableForgeStage("synthesizing")).toBe(true);
    expect(isFailableForgeStage("verifying")).toBe(true);
    expect(isFailableForgeStage("published")).toBe(false);
    expect(isFailableForgeStage("retired")).toBe(false);
    expect(isFailableForgeStage("failed")).toBe(false);
    expect(isFailableForgeStage("toString")).toBe(false);
    expect(isFailableForgeStage(42)).toBe(false);
  });

  test("enum guards reject prototype-chain keys (toString, constructor, __proto__)", () => {
    for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(isForgeLifecycleState(key)).toBe(false);
      expect(isPublishedForgeLifecycleState(key)).toBe(false);
      // forge_failed.stage uses isForgeLifecycleState, so this also covers that path.
    }
  });

  test("isPublishedForgeLifecycleState accepts only published/retired", () => {
    expect(isPublishedForgeLifecycleState("published")).toBe(true);
    expect(isPublishedForgeLifecycleState("retired")).toBe(true);
    expect(isPublishedForgeLifecycleState("failed")).toBe(false);
    expect(isPublishedForgeLifecycleState("verifying")).toBe(false);
    expect(isPublishedForgeLifecycleState("")).toBe(false);
    expect(isPublishedForgeLifecycleState(42)).toBe(false);
    expect(isPublishedForgeLifecycleState(null)).toBe(false);
  });

  test("isTerminalForgeLifecycle is true for published/failed/retired only", () => {
    expect(isTerminalForgeLifecycle("published")).toBe(true);
    expect(isTerminalForgeLifecycle("failed")).toBe(true);
    expect(isTerminalForgeLifecycle("retired")).toBe(true);
    expect(isTerminalForgeLifecycle("detected")).toBe(false);
    expect(isTerminalForgeLifecycle("proposed")).toBe(false);
    expect(isTerminalForgeLifecycle("synthesizing")).toBe(false);
    expect(isTerminalForgeLifecycle("verifying")).toBe(false);
  });
});

describe("@koi/forge-types — ForgeEvent", () => {
  test("isForgeEvent accepts every kind", () => {
    const events: ForgeEvent[] = [
      {
        kind: "demand_detected",
        demand: {
          signal: sampleSignal,
          status: "open",
          observedAt: 1,
          occurrences: 1,
        },
      },
      {
        kind: "candidate_proposed",
        candidate: {
          id: "c",
          kind: "tool",
          name: "n",
          description: "d",
          priority: 0,
          proposedScope: "agent",
          createdAt: 0,
        },
      },
      { kind: "synthesize_started", candidateId: "c" },
      { kind: "verify_started", candidateId: "c" },
      {
        kind: "forge_completed",
        candidateId: "c",
        artifact: {
          brick: sampleBrick,
          candidateId: "c",
          lifecycle: "published",
          verification: sampleSummary,
          forgedAt: 0,
          forgedBy: "agent-1",
        },
      },
      {
        kind: "forge_failed",
        candidateId: "c",
        stage: "verifying",
        reason: "x",
      },
      {
        kind: "policy_decision",
        candidateId: "c",
        verdict: { decision: "allow" },
      },
    ];
    for (const e of events) {
      expect(isForgeEvent(e)).toBe(true);
    }
  });

  test("isForgeEvent rejects malformed input", () => {
    expect(isForgeEvent(null)).toBe(false);
    expect(isForgeEvent(undefined)).toBe(false);
    expect(isForgeEvent("demand_detected")).toBe(false);
    expect(isForgeEvent({})).toBe(false);
    expect(isForgeEvent({ kind: "unknown" })).toBe(false);
    expect(isForgeEvent({ kind: 42 })).toBe(false);
  });

  test("isForgeEvent rejects per-variant payload shape errors", () => {
    // demand_detected: missing or malformed demand
    expect(isForgeEvent({ kind: "demand_detected" })).toBe(false);
    expect(isForgeEvent({ kind: "demand_detected", demand: { status: "open" } })).toBe(false);

    // candidate_proposed: missing required candidate fields
    expect(isForgeEvent({ kind: "candidate_proposed" })).toBe(false);
    expect(
      isForgeEvent({
        kind: "candidate_proposed",
        candidate: { id: "c", kind: "tool", name: "n", description: "d" },
      }),
    ).toBe(false);

    // synthesize_started / verify_started: candidateId must be a string
    expect(isForgeEvent({ kind: "synthesize_started" })).toBe(false);
    expect(isForgeEvent({ kind: "synthesize_started", candidateId: 7 })).toBe(false);
    expect(isForgeEvent({ kind: "verify_started", candidateId: null })).toBe(false);

    // forge_completed: missing artifact, or wrong-typed candidateId
    expect(isForgeEvent({ kind: "forge_completed", candidateId: "c" })).toBe(false);
    expect(isForgeEvent({ kind: "forge_completed", candidateId: 7, artifact: {} })).toBe(false);
    expect(
      isForgeEvent({
        kind: "forge_completed",
        candidateId: "c",
        artifact: { brick: {}, candidateId: 1 },
      }),
    ).toBe(false);

    // forge_failed: stage must be a pre-publication FailableForgeStage
    expect(
      isForgeEvent({ kind: "forge_failed", candidateId: "c", stage: "active", reason: "x" }),
    ).toBe(false);
    expect(isForgeEvent({ kind: "forge_failed", candidateId: "c", stage: "verifying" })).toBe(
      false,
    );
    expect(
      isForgeEvent({ kind: "forge_failed", candidateId: "c", stage: "verifying", reason: 1 }),
    ).toBe(false);
    // Reject success stages — failure cannot occur from published/retired/failed.
    for (const stage of ["published", "retired", "failed"]) {
      expect(isForgeEvent({ kind: "forge_failed", candidateId: "c", stage, reason: "x" })).toBe(
        false,
      );
    }

    // Optional fields, when present, must be valid types.
    expect(
      isForgeEvent({
        kind: "candidate_proposed",
        candidate: {
          id: "c",
          kind: "tool",
          name: "n",
          description: "d",
          demandId: 7, // wrong type
          priority: 0,
          proposedScope: "agent",
          createdAt: 0,
        },
      }),
    ).toBe(false);
    expect(
      isForgeEvent({
        kind: "demand_detected",
        demand: {
          signal: {},
          status: "open",
          observedAt: 0,
          occurrences: 1,
          resolvedAt: "yesterday", // wrong type
        },
      }),
    ).toBe(false);

    // Arrays are not valid object payloads (typeof [] === "object" but they are not records).
    expect(isForgeEvent({ kind: "demand_detected", demand: [] })).toBe(false);
    expect(
      isForgeEvent({
        kind: "forge_completed",
        candidateId: "c",
        artifact: {
          brick: [], // array, not a record
          candidateId: "c",
          lifecycle: "published",
          verification: {},
          forgedAt: 0,
          forgedBy: "a",
        },
      }),
    ).toBe(false);

    // priority must be in [0, 1].
    for (const priority of [-0.1, 1.5, 5, -100]) {
      expect(
        isForgeEvent({
          kind: "candidate_proposed",
          candidate: {
            id: "c",
            kind: "tool",
            name: "n",
            description: "d",
            priority,
            proposedScope: "agent",
            createdAt: 0,
          },
        }),
      ).toBe(false);
    }

    // Numeric fields must be finite — NaN/Infinity rejected.
    expect(
      isForgeEvent({
        kind: "candidate_proposed",
        candidate: {
          id: "c",
          kind: "tool",
          name: "n",
          description: "d",
          priority: Number.NaN,
          proposedScope: "agent",
          createdAt: 0,
        },
      }),
    ).toBe(false);
    expect(
      isForgeEvent({
        kind: "demand_detected",
        demand: {
          signal: {},
          status: "open",
          observedAt: Number.POSITIVE_INFINITY,
          occurrences: 1,
        },
      }),
    ).toBe(false);

    // candidate_proposed: invalid enum-backed fields rejected
    expect(
      isForgeEvent({
        kind: "candidate_proposed",
        candidate: {
          id: "c",
          kind: "not-a-real-kind",
          name: "n",
          description: "d",
          priority: 0,
          proposedScope: "agent",
          createdAt: 0,
        },
      }),
    ).toBe(false);
    expect(
      isForgeEvent({
        kind: "candidate_proposed",
        candidate: {
          id: "c",
          kind: "tool",
          name: "n",
          description: "d",
          priority: 0,
          proposedScope: "GLOBAL",
          createdAt: 0,
        },
      }),
    ).toBe(false);

    // demand_detected: status must be a known ForgeDemandStatus
    expect(
      isForgeEvent({
        kind: "demand_detected",
        demand: { signal: {}, status: "weird", observedAt: 0, occurrences: 1 },
      }),
    ).toBe(false);

    // demand_detected: occurrences must be a positive integer
    for (const occurrences of [0, -1, 1.5, Number.NaN]) {
      expect(
        isForgeEvent({
          kind: "demand_detected",
          demand: { signal: {}, status: "open", observedAt: 0, occurrences },
        }),
      ).toBe(false);
    }
    // demand_detected: timestamps must be non-negative
    expect(
      isForgeEvent({
        kind: "demand_detected",
        demand: { signal: {}, status: "open", observedAt: -1, occurrences: 1 },
      }),
    ).toBe(false);
    expect(
      isForgeEvent({
        kind: "demand_detected",
        demand: {
          signal: {},
          status: "open",
          observedAt: 5,
          occurrences: 1,
          resolvedAt: -1,
        },
      }),
    ).toBe(false);
    // demand_detected: resolvedAt must be >= observedAt
    expect(
      isForgeEvent({
        kind: "demand_detected",
        demand: {
          signal: {},
          status: "accepted",
          observedAt: 100,
          occurrences: 1,
          resolvedAt: 50,
        },
      }),
    ).toBe(false);
    // demand_detected: equal timestamps are allowed (resolved-at-observe).
    expect(
      isForgeEvent({
        kind: "demand_detected",
        demand: {
          signal: {},
          status: "accepted",
          observedAt: 100,
          occurrences: 1,
          resolvedAt: 100,
        },
      }),
    ).toBe(true);

    // forge_completed: artifact.lifecycle must be exactly "published" — `retired` is stale state.
    expect(
      isForgeEvent({
        kind: "forge_completed",
        candidateId: "c",
        artifact: {
          brick: {},
          candidateId: "c",
          lifecycle: "retired",
          verification: {},
          forgedAt: 0,
          forgedBy: "a",
        },
      }),
    ).toBe(false);

    // forge_completed: top-level candidateId must match artifact.candidateId
    expect(
      isForgeEvent({
        kind: "forge_completed",
        candidateId: "A",
        artifact: {
          brick: {},
          candidateId: "B",
          lifecycle: "published",
          verification: {},
          forgedAt: 0,
          forgedBy: "a",
        },
      }),
    ).toBe(false);

    // forge_completed: artifact lifecycle must be a published-only state
    expect(
      isForgeEvent({
        kind: "forge_completed",
        candidateId: "c",
        artifact: {
          brick: {},
          candidateId: "c",
          lifecycle: "failed",
          verification: {},
          forgedAt: 0,
          forgedBy: "a",
        },
      }),
    ).toBe(false);
    expect(
      isForgeEvent({
        kind: "forge_completed",
        candidateId: "c",
        artifact: {
          brick: {},
          candidateId: "c",
          lifecycle: "verifying",
          verification: {},
          forgedAt: 0,
          forgedBy: "a",
        },
      }),
    ).toBe(false);

    // policy_decision: verdict must be a valid discriminated-union value
    expect(isForgeEvent({ kind: "policy_decision", candidateId: "c" })).toBe(false);
    expect(
      isForgeEvent({
        kind: "policy_decision",
        candidateId: "c",
        verdict: { decision: "deny" },
      }),
    ).toBe(false);
    expect(
      isForgeEvent({
        kind: "policy_decision",
        candidateId: "c",
        verdict: { decision: "weird" },
      }),
    ).toBe(false);
    expect(
      isForgeEvent({
        kind: "policy_decision",
        candidateId: 7,
        verdict: { decision: "allow" },
      }),
    ).toBe(false);
  });
});

describe("@koi/forge-types — tool/middleware contracts", () => {
  test("ForgeToolInput satisfies shape", () => {
    const input: ForgeToolInput = {
      kind: "tool",
      name: "csv-parse",
      description: "Parse CSV",
      spec: { code: "export default () => {}" },
    };
    expect(input.scope).toBeUndefined();
    expect(input.kind).toBe("tool");
  });

  test("ForgeToolResult success path", () => {
    const result: ForgeToolResult = {
      ok: true,
      artifact: {
        brick: sampleBrick,
        candidateId: "c",
        lifecycle: "published",
        verification: sampleSummary,
        forgedAt: 0,
        forgedBy: "agent-1",
      },
    };
    expect(result.ok).toBe(true);
    expect(result.artifact?.candidateId).toBe("c");
  });

  test("ForgeToolResult error path", () => {
    const result: ForgeToolResult = { ok: false, error: "synthesis failed" };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("synthesis failed");
  });

  test("ForgeToolResult disallows contradictory states at compile time", () => {
    // @ts-expect-error — ok: true requires artifact
    const _missingArtifact: ForgeToolResult = { ok: true };
    // @ts-expect-error — ok: false requires error
    const _missingError: ForgeToolResult = { ok: false };
    // @ts-expect-error — ok: true cannot carry an error (artifact slot is `never`)
    const _trueWithError: ForgeToolResult = { ok: true, error: "x" };
    // @ts-expect-error — ok: false cannot carry an artifact (artifact slot is `never`)
    const _falseWithArtifact: ForgeToolResult = { ok: false, error: "x", artifact: {} };
    // Reference unused locals so noUnusedLocals doesn't fire.
    expect([_missingArtifact, _missingError, _trueWithError, _falseWithArtifact]).toHaveLength(4);
  });

  test("ForgeMiddlewareConfig satisfies shape", () => {
    const cfg: ForgeMiddlewareConfig = {
      enabled: true,
      emitDemand: true,
      autoSynthesize: false,
    };
    expect(cfg.enabled).toBe(true);
    expect(cfg.autoSynthesize).toBe(false);
  });
});
