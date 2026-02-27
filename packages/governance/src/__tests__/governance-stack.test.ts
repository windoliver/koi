/**
 * Unit and integration tests for createGovernanceStack().
 *
 * Unit tests (black-box by name):
 *   - Empty config → 0 middlewares
 *   - Single middleware present and named correctly
 *   - All 9 configured → 9 middlewares in correct priority order
 *   - exec-approvals priority overridden to 110
 *   - delegation priority overridden to 120
 *
 * Integration test:
 *   - createGovernanceStack({ audit }) → pass to createKoi + cooperating adapter
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
} from "@koi/core";
import type { GovernanceBackend, GovernanceVerdict } from "@koi/core/governance-backend";
import { createKoi } from "@koi/engine";
import { createInMemoryAuditSink } from "@koi/middleware-audit";
import { createGovernanceStack } from "../governance-stack.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAllowGovernanceBackend(): GovernanceBackend {
  return {
    evaluator: { evaluate: async (): Promise<GovernanceVerdict> => ({ ok: true }) },
  };
}

function makeDoneOutput(): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 },
  };
}

function makeNoopAdapter(): EngineAdapter {
  return {
    engineId: "noop",
    terminals: {
      modelCall: async () => ({ content: "ok", model: "test" }),
    },
    stream: (_input: EngineInput) => ({
      async *[Symbol.asyncIterator]() {
        yield { kind: "done" as const, output: makeDoneOutput() };
      },
    }),
  };
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

const BASE_MANIFEST: AgentManifest = {
  name: "governance-stack-test",
  version: "1.0.0",
  model: { name: "test-model" },
};

// ---------------------------------------------------------------------------
// Unit tests — createGovernanceStack composability
// ---------------------------------------------------------------------------

describe("createGovernanceStack", () => {
  // ── Empty config ────────────────────────────────────────────────────────

  test("empty config returns 0 middlewares", () => {
    const { middlewares } = createGovernanceStack({});
    expect(middlewares).toHaveLength(0);
  });

  // ── Single middleware presence by name ──────────────────────────────────

  test("audit only → 1 middleware named 'audit'", () => {
    const sink = createInMemoryAuditSink();
    const { middlewares } = createGovernanceStack({ audit: { sink } });
    expect(middlewares).toHaveLength(1);
    expect(middlewares[0]?.name).toBe("audit");
  });

  test("governanceBackend only → 1 middleware named 'koi:governance-backend'", () => {
    const { middlewares } = createGovernanceStack({
      governanceBackend: { backend: makeAllowGovernanceBackend() },
    });
    expect(middlewares).toHaveLength(1);
    expect(middlewares[0]?.name).toBe("koi:governance-backend");
  });

  // ── Full 9-middleware stack ──────────────────────────────────────────────

  test("all 9 configured → 9 middlewares", () => {
    const sink = createInMemoryAuditSink();
    const { middlewares } = createGovernanceStack({
      permissions: {
        backend: {
          check: () => ({ effect: "allow" as const }),
        },
      },
      execApprovals: {
        rules: { allow: ["*"], deny: [], ask: [] },
        onAsk: async () => ({ kind: "allow_once" as const }),
      },
      delegation: {
        secret: "test-secret",
        registry: {
          isRevoked: async () => false,
          revoke: async () => undefined,
        },
        grantStore: new Map(),
      },
      governanceBackend: { backend: makeAllowGovernanceBackend() },
      pay: {
        tracker: {
          record: async () => undefined,
          totalSpend: async () => 0,
          remaining: async () => 1000,
        },
        calculator: { calculate: () => 0 },
        budget: 1000,
      },
      audit: { sink },
      pii: {
        strategy: "redact",
      },
      sanitize: {
        rules: [],
      },
      guardrails: {
        rules: [],
      },
    });
    expect(middlewares).toHaveLength(9);
  });

  test("all 9 ordered by priority ascending", () => {
    const sink = createInMemoryAuditSink();
    const { middlewares } = createGovernanceStack({
      permissions: {
        backend: {
          check: () => ({ effect: "allow" as const }),
        },
      },
      execApprovals: {
        rules: { allow: ["*"], deny: [], ask: [] },
        onAsk: async () => ({ kind: "allow_once" as const }),
      },
      delegation: {
        secret: "test-secret",
        registry: {
          isRevoked: async () => false,
          revoke: async () => undefined,
        },
        grantStore: new Map(),
      },
      governanceBackend: { backend: makeAllowGovernanceBackend() },
      pay: {
        tracker: {
          record: async () => undefined,
          totalSpend: async () => 0,
          remaining: async () => 1000,
        },
        calculator: { calculate: () => 0 },
        budget: 1000,
      },
      audit: { sink },
      pii: { strategy: "redact" },
      sanitize: { rules: [] },
      guardrails: { rules: [] },
    });

    // Extract priorities (undefined defaults to 500 per L1 convention)
    const priorities = middlewares.map((mw) => mw.priority ?? 500);

    // Should be sorted ascending
    for (let i = 1; i < priorities.length; i++) {
      const prev = priorities[i - 1];
      const curr = priorities[i];
      if (prev !== undefined && curr !== undefined) {
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    }
  });

  // ── Priority overrides ──────────────────────────────────────────────────

  test("exec-approvals priority is overridden to 110", () => {
    const { middlewares } = createGovernanceStack({
      execApprovals: {
        rules: { allow: [], deny: [], ask: [] },
        onAsk: async () => ({ kind: "deny_once" as const, reason: "test" }),
      },
    });
    expect(middlewares).toHaveLength(1);
    expect(middlewares[0]?.name).toBe("exec-approvals");
    expect(middlewares[0]?.priority).toBe(110);
  });

  test("delegation priority is overridden to 120", () => {
    const { middlewares } = createGovernanceStack({
      delegation: {
        secret: "s",
        registry: {
          isRevoked: async () => false,
          revoke: async () => undefined,
        },
        grantStore: new Map(),
      },
    });
    expect(middlewares).toHaveLength(1);
    expect(middlewares[0]?.name).toBe("koi:delegation");
    expect(middlewares[0]?.priority).toBe(120);
  });

  // ── Return value is immutable-shaped ────────────────────────────────────

  test("returns object with 'middlewares' property", () => {
    const result = createGovernanceStack({});
    expect(result).toHaveProperty("middlewares");
    expect(Array.isArray(result.middlewares)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration test — full createKoi round-trip
// ---------------------------------------------------------------------------

describe("createGovernanceStack integration", () => {
  test("audit-only stack: createKoi run succeeds without throwing", async () => {
    const sink = createInMemoryAuditSink();
    const { middlewares } = createGovernanceStack({ audit: { sink } });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeNoopAdapter(),
      middleware: middlewares,
      providers: [],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "hello" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");

    await runtime.dispose();
  });

  test("governance-backend-only stack: allowed backend passes through cleanly", async () => {
    const { middlewares } = createGovernanceStack({
      governanceBackend: { backend: makeAllowGovernanceBackend() },
    });

    const runtime = await createKoi({
      manifest: BASE_MANIFEST,
      adapter: makeNoopAdapter(),
      middleware: middlewares,
      providers: [],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "hello" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");

    await runtime.dispose();
  });
});
