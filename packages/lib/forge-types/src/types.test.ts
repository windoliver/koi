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
import { isForgeEvent, isForgeLifecycleState, isTerminalForgeLifecycle } from "./types.js";

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
