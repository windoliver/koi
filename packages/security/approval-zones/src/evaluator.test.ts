import { describe, expect, it } from "bun:test";
import type { PermissionQuery } from "@koi/core";
import { createZoneEvaluator } from "./evaluator.js";
import type { RiskAssessment, RiskScorer } from "./risk-types.js";
import type { ApprovalZone } from "./zone-types.js";

const fixedScorer = (a: RiskAssessment): RiskScorer => ({ score: () => a });

const baseQuery: PermissionQuery = {
  principal: "agent:main",
  action: "read",
  resource: "/proj/x.ts",
};

describe("createZoneEvaluator", () => {
  it("returns ask:no-match when no zones match", async () => {
    const ev = createZoneEvaluator({
      zones: [{ name: "z", match: { tools: ["write"] }, action: "auto" }],
      scorer: fixedScorer({ tier: "low", reasons: [] }),
    });
    const v = await ev.evaluate(baseQuery);
    expect(v).toEqual({ kind: "ask", reason: "no-match" });
  });

  it("returns auto when zone matches and risk ≤ maxRisk", async () => {
    const zone: ApprovalZone = {
      name: "ro",
      match: { tools: ["read"] },
      action: "auto",
      maxRisk: "low",
    };
    const ev = createZoneEvaluator({
      zones: [zone],
      scorer: fixedScorer({ tier: "low", reasons: ["in-project"] }),
    });
    const v = await ev.evaluate(baseQuery);
    expect(v.kind).toBe("auto");
    if (v.kind === "auto") expect(v.zone).toBe("ro");
  });

  it("returns ask:risk-exceeded when risk > maxRisk", async () => {
    const zone: ApprovalZone = {
      name: "ro",
      match: { tools: ["read"] },
      action: "auto",
      maxRisk: "low",
    };
    const ev = createZoneEvaluator({
      zones: [zone],
      scorer: fixedScorer({ tier: "high", reasons: ["x"] }),
    });
    const v = await ev.evaluate(baseQuery);
    expect(v.kind).toBe("ask");
    if (v.kind === "ask") expect(v.reason).toBe("risk-exceeded");
  });

  it("default maxRisk is 'low' when omitted", async () => {
    const ev = createZoneEvaluator({
      zones: [{ name: "z", match: {}, action: "auto" }],
      scorer: fixedScorer({ tier: "medium", reasons: [] }),
    });
    const v = await ev.evaluate(baseQuery);
    expect(v.kind).toBe("ask");
    if (v.kind === "ask") expect(v.reason).toBe("risk-exceeded");
  });

  it("returns sandbox for sandbox-then-auto on bash with backendId", async () => {
    const ev = createZoneEvaluator({
      zones: [
        {
          name: "cleanup",
          match: { tools: ["bash"] },
          action: "sandbox-then-auto",
          maxRisk: "medium",
          sandboxBackendId: "default",
        },
      ],
      scorer: fixedScorer({ tier: "medium", reasons: [] }),
    });
    const v = await ev.evaluate({ ...baseQuery, action: "bash" });
    expect(v.kind).toBe("sandbox");
    if (v.kind === "sandbox") expect(v.backendId).toBe("default");
  });

  it("returns ask:non-bash-tool for sandbox action on non-bash tool", async () => {
    const ev = createZoneEvaluator({
      zones: [
        {
          name: "z",
          match: { tools: ["write"] },
          action: "sandbox-then-auto",
          maxRisk: "high",
          sandboxBackendId: "default",
        },
      ],
      scorer: fixedScorer({ tier: "low", reasons: [] }),
    });
    const v = await ev.evaluate({ ...baseQuery, action: "write" });
    expect(v.kind).toBe("ask");
    if (v.kind === "ask") expect(v.reason).toBe("non-bash-tool");
  });

  it("returns ask:missing-backend when sandbox-then-auto omits sandboxBackendId", async () => {
    const ev = createZoneEvaluator({
      zones: [
        {
          name: "z",
          match: { tools: ["bash"] },
          action: "sandbox-then-auto",
          maxRisk: "medium",
        },
      ],
      scorer: fixedScorer({ tier: "low", reasons: [] }),
    });
    const v = await ev.evaluate({ ...baseQuery, action: "bash" });
    expect(v.kind).toBe("ask");
    if (v.kind === "ask") expect(v.reason).toBe("missing-backend");
  });

  it("returns first-match-wins across multiple zones", async () => {
    const ev = createZoneEvaluator({
      zones: [
        { name: "first", match: { tools: ["read"] }, action: "auto", maxRisk: "low" },
        { name: "second", match: { tools: ["read"] }, action: "ask" },
      ],
      scorer: fixedScorer({ tier: "low", reasons: [] }),
    });
    const v = await ev.evaluate(baseQuery);
    expect(v.kind).toBe("auto");
    if (v.kind === "auto") expect(v.zone).toBe("first");
  });

  it("returns ask:matcher-error when matcher throws", async () => {
    const evilZone = {
      name: "evil",
      get match() {
        throw new Error("boom");
      },
      action: "auto" as const,
    } as unknown as ApprovalZone;
    const ev = createZoneEvaluator({
      zones: [evilZone],
      scorer: fixedScorer({ tier: "low", reasons: [] }),
    });
    const v = await ev.evaluate(baseQuery);
    expect(v.kind).toBe("ask");
    if (v.kind === "ask") expect(v.reason).toBe("matcher-error");
  });

  it("returns ask:scorer-error when scorer throws", async () => {
    const ev = createZoneEvaluator({
      zones: [{ name: "z", match: { tools: ["read"] }, action: "auto", maxRisk: "low" }],
      scorer: {
        score: () => {
          throw new Error("boom");
        },
      },
    });
    const v = await ev.evaluate(baseQuery);
    expect(v.kind).toBe("ask");
    if (v.kind === "ask") expect(v.reason).toBe("scorer-error");
  });
});
