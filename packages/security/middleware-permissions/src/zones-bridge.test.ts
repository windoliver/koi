import { describe, expect, it, mock } from "bun:test";
import type { RiskScorer } from "@koi/approval-zones";
import { createZoneEvaluator } from "@koi/approval-zones";
import type { PermissionQuery } from "@koi/core";
import { applyZoneVerdict, type ZoneAuditSink } from "./zones-bridge.js";

const scorer: RiskScorer = { score: () => ({ tier: "low", reasons: [] }) };

const baseQuery: PermissionQuery = {
  principal: "agent:main",
  action: "read",
  resource: "/proj/x.ts",
};

function makeSink(): { events: { event: string; meta: unknown }[]; sink: ZoneAuditSink } {
  const events: { event: string; meta: unknown }[] = [];
  return {
    events,
    sink: { record: (event, meta) => events.push({ event, meta }) },
  };
}

describe("applyZoneVerdict", () => {
  it("returns 'auto-allow' and emits zone-auto for auto verdict", async () => {
    const ev = createZoneEvaluator({
      zones: [{ name: "ro", match: { tools: ["read"] }, action: "auto", maxRisk: "low" }],
      scorer,
    });
    const { events, sink } = makeSink();
    const result = await applyZoneVerdict({
      query: baseQuery,
      evaluator: ev,
      sandboxRouter: undefined,
      auditSink: sink,
    });
    expect(result.outcome).toBe("auto-allow");
    expect(events.map((e) => e.event)).toEqual(["zone-auto"]);
  });

  it("returns 'fall-through' silently when no zone matches", async () => {
    const ev = createZoneEvaluator({ zones: [], scorer });
    const { events, sink } = makeSink();
    const result = await applyZoneVerdict({
      query: baseQuery,
      evaluator: ev,
      sandboxRouter: undefined,
      auditSink: sink,
    });
    expect(result.outcome).toBe("fall-through");
    expect(events).toHaveLength(0);
  });

  it("emits zone-ask-passthrough when matched zone exceeds maxRisk", async () => {
    const ev = createZoneEvaluator({
      zones: [{ name: "ro", match: { tools: ["read"] }, action: "auto", maxRisk: "low" }],
      scorer: { score: () => ({ tier: "high", reasons: ["x"] }) },
    });
    const { events, sink } = makeSink();
    const result = await applyZoneVerdict({
      query: baseQuery,
      evaluator: ev,
      sandboxRouter: undefined,
      auditSink: sink,
    });
    expect(result.outcome).toBe("fall-through");
    expect(events.map((e) => e.event)).toEqual(["zone-ask-passthrough"]);
  });

  it("runs sandbox preview, on success returns 'auto-allow' and emits sandbox-ok + zone-auto", async () => {
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
      scorer,
    });
    const exec = mock(async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      oomKilled: false,
    }));
    const destroy = mock(async () => {});
    const sandboxRouter = {
      create: mock(async () => ({
        ok: true as const,
        value: {
          instance: {
            exec,
            readFile: async () => new Uint8Array(),
            writeFile: async () => {},
            destroy,
          },
          decision: { selected: { name: "default" } },
        },
      })),
      describe: () => [],
      shutdown: async () => {},
    };
    const { events, sink } = makeSink();
    const result = await applyZoneVerdict({
      query: { ...baseQuery, action: "bash", context: { command: "ls /tmp" } },
      evaluator: ev,
      sandboxRouter: sandboxRouter as unknown as Parameters<
        typeof applyZoneVerdict
      >[0]["sandboxRouter"],
      auditSink: sink,
    });
    expect(result.outcome).toBe("auto-allow");
    expect(events.map((e) => e.event)).toEqual([
      "zone-sandbox-preview",
      "zone-sandbox-ok",
      "zone-auto",
    ]);
    expect(destroy).toHaveBeenCalled();
  });

  it("on sandbox failure (non-zero exit), returns 'fall-through' and emits sandbox-failed", async () => {
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
      scorer,
    });
    const exec = mock(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "err",
      durationMs: 1,
      timedOut: false,
      oomKilled: false,
    }));
    const destroy = mock(async () => {});
    const sandboxRouter = {
      create: mock(async () => ({
        ok: true as const,
        value: {
          instance: {
            exec,
            readFile: async () => new Uint8Array(),
            writeFile: async () => {},
            destroy,
          },
          decision: { selected: { name: "default" } },
        },
      })),
      describe: () => [],
      shutdown: async () => {},
    };
    const { events, sink } = makeSink();
    const result = await applyZoneVerdict({
      query: { ...baseQuery, action: "bash", context: { command: "ls /tmp" } },
      evaluator: ev,
      sandboxRouter: sandboxRouter as unknown as Parameters<
        typeof applyZoneVerdict
      >[0]["sandboxRouter"],
      auditSink: sink,
    });
    expect(result.outcome).toBe("fall-through");
    expect(events.map((e) => e.event)).toEqual(["zone-sandbox-preview", "zone-sandbox-failed"]);
  });

  it("on sandbox verdict without a router configured, falls through with sandbox-failed", async () => {
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
      scorer,
    });
    const { events, sink } = makeSink();
    const result = await applyZoneVerdict({
      query: { ...baseQuery, action: "bash", context: { command: "ls /tmp" } },
      evaluator: ev,
      sandboxRouter: undefined,
      auditSink: sink,
    });
    expect(result.outcome).toBe("fall-through");
    expect(events.map((e) => e.event)).toContain("zone-sandbox-failed");
  });
});
