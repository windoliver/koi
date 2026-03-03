/**
 * Unit and integration tests for createGovernanceStack().
 *
 * Unit tests (black-box by name):
 *   - Empty config → open preset permissions middleware
 *   - Single middleware present and named correctly
 *   - All 9 configured → 9 middlewares in correct priority order
 *   - All 8 configured (no pay) → 8 middlewares
 *   - exec-approvals priority overridden to 110
 *   - delegation priority overridden to 120
 *   - Preset: standard → permissions + pii + sanitize
 *   - Preset: strict → permissions + pii + sanitize + guardrails
 *   - Return value includes providers and config metadata
 *   - Pay deprecation warning + still functional
 *
 * Integration test:
 *   - createGovernanceStack({ audit }) → pass to createKoi + cooperating adapter
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  Agent,
  AgentManifest,
  AgentMessage,
  AgentMessageInput,
  ComponentProvider,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
  MailboxComponent,
  SubsystemToken,
} from "@koi/core";
import { agentId, MAILBOX, messageId } from "@koi/core";
import type { KoiError, Result } from "@koi/core/errors";
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
    capabilities: { text: true, images: false, files: false, audio: false },
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

function makePayTracker(): {
  readonly record: () => Promise<undefined>;
  readonly totalSpend: () => Promise<number>;
  readonly remaining: () => Promise<number>;
  readonly breakdown: () => Promise<{
    readonly totalCostUsd: number;
    readonly byModel: readonly [];
    readonly byTool: readonly [];
  }>;
} {
  return {
    record: async () => undefined,
    totalSpend: async () => 0,
    remaining: async () => 1000,
    breakdown: async () => ({ totalCostUsd: 0, byModel: [], byTool: [] }),
  };
}

// ---------------------------------------------------------------------------
// Unit tests — createGovernanceStack composability
// ---------------------------------------------------------------------------

describe("createGovernanceStack", () => {
  // Capture console.warn for pay deprecation tests
  const originalWarn = console.warn;
  let warnSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    warnSpy = mock(() => undefined);
    console.warn = warnSpy;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  // ── Empty config (open preset) ────────────────────────────────────────

  test("empty config resolves open preset → permissions middleware", () => {
    const { middlewares } = createGovernanceStack({});
    // Open preset creates permissions middleware from permissionRules: { allow: ["*"] }
    expect(middlewares).toHaveLength(1);
    expect(middlewares[0]?.name).toBe("permissions");
  });

  // ── Single middleware + open preset ──────────────────────────────────

  test("audit only → permissions + audit middleware", () => {
    const sink = createInMemoryAuditSink();
    const { middlewares } = createGovernanceStack({ audit: { sink } });
    // Open preset adds permissions, user adds audit
    expect(middlewares).toHaveLength(2);
    const names = middlewares.map((mw) => mw.name);
    expect(names).toContain("permissions");
    expect(names).toContain("audit");
  });

  test("governanceBackend only → permissions + governance-backend", () => {
    const { middlewares } = createGovernanceStack({
      governanceBackend: { backend: makeAllowGovernanceBackend() },
    });
    expect(middlewares).toHaveLength(2);
    const names = middlewares.map((mw) => mw.name);
    expect(names).toContain("permissions");
    expect(names).toContain("koi:governance-backend");
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
        tracker: makePayTracker(),
        calculator: { calculate: () => 0 },
        budget: 1000,
      },
      audit: { sink },
      pii: { strategy: "redact" },
      sanitize: { rules: [] },
      guardrails: { rules: [] },
    });
    expect(middlewares).toHaveLength(9);
  });

  test("all 8 configured without pay → 8 middlewares", () => {
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
      audit: { sink },
      pii: { strategy: "redact" },
      sanitize: { rules: [] },
      guardrails: { rules: [] },
    });
    expect(middlewares).toHaveLength(8);
    expect(warnSpy).not.toHaveBeenCalled();
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
        tracker: makePayTracker(),
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
    const ea = middlewares.find((mw) => mw.name === "exec-approvals");
    expect(ea).toBeDefined();
    expect(ea?.priority).toBe(110);
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
    const del = middlewares.find((mw) => mw.name === "koi:delegation");
    expect(del).toBeDefined();
    expect(del?.priority).toBe(120);
  });

  // ── Return value shape ────────────────────────────────────────────────

  test("returns GovernanceBundle with middlewares, providers, and config", () => {
    const result = createGovernanceStack({});
    expect(result).toHaveProperty("middlewares");
    expect(result).toHaveProperty("providers");
    expect(result).toHaveProperty("config");
    expect(Array.isArray(result.middlewares)).toBe(true);
    expect(Array.isArray(result.providers)).toBe(true);
  });

  test("config metadata reflects open preset", () => {
    const { config } = createGovernanceStack({});
    expect(config.preset).toBe("open");
    expect(config.middlewareCount).toBe(1); // permissions from open
    expect(config.providerCount).toBe(0);
    expect(config.payDeprecated).toBe(false);
    expect(config.scopeEnabled).toBe(false);
  });

  test("providers is empty when no backends provided", () => {
    const { providers } = createGovernanceStack({ preset: "strict" });
    expect(providers).toHaveLength(0);
  });

  // ── Preset tests ──────────────────────────────────────────────────────

  test("preset: standard → permissions + pii + sanitize", () => {
    const { middlewares, config } = createGovernanceStack({ preset: "standard" });
    const names = middlewares.map((mw) => mw.name);
    expect(names).toContain("permissions");
    expect(names).toContain("pii");
    expect(names).toContain("sanitize");
    expect(config.preset).toBe("standard");
    expect(config.scopeEnabled).toBe(true); // standard has scope config
  });

  test("preset: strict → permissions + pii + sanitize + guardrails", () => {
    const { middlewares, config } = createGovernanceStack({ preset: "strict" });
    const names = middlewares.map((mw) => mw.name);
    expect(names).toContain("permissions");
    expect(names).toContain("pii");
    expect(names).toContain("sanitize");
    expect(names).toContain("guardrails");
    expect(config.preset).toBe("strict");
    expect(config.scopeEnabled).toBe(true);
  });

  test("preset ordering invariant: open count ≤ standard count ≤ strict count", () => {
    const openCount = createGovernanceStack({ preset: "open" }).middlewares.length;
    const stdCount = createGovernanceStack({ preset: "standard" }).middlewares.length;
    const strictCount = createGovernanceStack({ preset: "strict" }).middlewares.length;
    expect(stdCount).toBeGreaterThanOrEqual(openCount);
    expect(strictCount).toBeGreaterThanOrEqual(stdCount);
  });

  // ── Pay deprecation ─────────────────────────────────────────────────

  test("pay deprecated but still functional → 9 middlewares + console.warn", () => {
    const sink = createInMemoryAuditSink();
    const { middlewares, config } = createGovernanceStack({
      permissions: {
        backend: { check: () => ({ effect: "allow" as const }) },
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
        tracker: makePayTracker(),
        calculator: { calculate: () => 0 },
        budget: 1000,
      },
      audit: { sink },
      pii: { strategy: "redact" },
      sanitize: { rules: [] },
      guardrails: { rules: [] },
    });
    expect(middlewares).toHaveLength(9);
    expect(config.payDeprecated).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("deprecated");
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

  test("governance-backend-only stack: allowed backend passes through cleanly (integration)", async () => {
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

// ---------------------------------------------------------------------------
// Agent approval routing — auto-discovery via ComponentProvider
// ---------------------------------------------------------------------------

function createMockMailbox(): MailboxComponent {
  const handlers: Array<(msg: AgentMessage) => void | Promise<void>> = [];
  let counter = 0;

  return {
    send: async (input: AgentMessageInput): Promise<Result<AgentMessage, KoiError>> => {
      counter++;
      const msg: AgentMessage = {
        ...input,
        id: messageId(`msg-${counter}`),
        createdAt: new Date().toISOString(),
      };
      for (const handler of handlers) {
        handler(msg);
      }
      return { ok: true, value: msg };
    },
    onMessage: (handler: (msg: AgentMessage) => void | Promise<void>): (() => void) => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    list: async () => [],
  };
}

/** Create a minimal mock Agent for ComponentProvider.attach() testing. */
function createMockAgent(opts: {
  readonly id: string;
  readonly parent?: string | undefined;
  readonly mailbox?: MailboxComponent | undefined;
}): Agent {
  const components = new Map<string, unknown>();
  if (opts.mailbox !== undefined) {
    components.set(MAILBOX as string, opts.mailbox);
  }

  return {
    pid: {
      id: agentId(opts.id),
      name: `agent-${opts.id}`,
      type: "worker",
      depth: opts.parent !== undefined ? 1 : 0,
      ...(opts.parent !== undefined ? { parent: agentId(opts.parent) } : {}),
    },
    manifest: { name: `agent-${opts.id}`, version: "1.0.0", model: { name: "test" } },
    state: "running",
    component: <T>(token: SubsystemToken<T>): T | undefined =>
      components.get(token as string) as T | undefined,
    has: (token: SubsystemToken<unknown>): boolean => components.has(token as string),
    hasAll: (...tokens: readonly SubsystemToken<unknown>[]): boolean =>
      tokens.every((t) => components.has(t as string)),
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: (): ReadonlyMap<string, unknown> => components,
  };
}

function findApprovalProvider(
  providers: readonly ComponentProvider[],
): ComponentProvider | undefined {
  return providers.find((p) => p.name === "koi:approval-routing");
}

describe("createGovernanceStack — agent approval routing", () => {
  // Provider is returned when exec-approvals is configured
  test("exec-approvals configured → approval-routing provider in providers", () => {
    const { providers } = createGovernanceStack({
      execApprovals: {
        rules: { allow: ["*"], deny: [], ask: [] },
        onAsk: async () => ({ kind: "allow_once" as const }),
      },
    });
    const approvalProvider = findApprovalProvider(providers);
    expect(approvalProvider).toBeDefined();
    expect(approvalProvider?.name).toBe("koi:approval-routing");
  });

  // No provider when no exec-approvals
  test("no exec-approvals → no approval-routing provider", () => {
    const { providers } = createGovernanceStack({});
    const approvalProvider = findApprovalProvider(providers);
    expect(approvalProvider).toBeUndefined();
  });

  // Child agent with parent + mailbox → wires child→parent routing
  test("attach with parent + mailbox → wires parent-side handler (disposable)", async () => {
    const mailbox = createMockMailbox();
    const { providers, disposables } = createGovernanceStack({
      execApprovals: {
        rules: { allow: ["*"], deny: [], ask: [] },
        onAsk: async () => ({ kind: "allow_once" as const }),
      },
    });

    const approvalProvider = findApprovalProvider(providers);
    expect(approvalProvider).toBeDefined();

    const agent = createMockAgent({ id: "child-1", parent: "parent-1", mailbox });
    await approvalProvider?.attach(agent);

    expect(disposables.length).toBeGreaterThanOrEqual(1);
  });

  // Agent without parent but with mailbox → still wires parent-side handler
  test("attach without parent + with mailbox → wires parent-side handler only", async () => {
    const mailbox = createMockMailbox();
    const { providers, disposables } = createGovernanceStack({
      execApprovals: {
        rules: { allow: ["*"], deny: [], ask: [] },
        onAsk: async () => ({ kind: "allow_once" as const }),
      },
    });

    const approvalProvider = findApprovalProvider(providers);
    const agent = createMockAgent({ id: "agent-1", mailbox });
    await approvalProvider?.attach(agent);

    expect(disposables).toHaveLength(1); // parent-side only, no child routing
  });

  // Agent without mailbox → no handlers wired
  test("attach without mailbox → no handlers wired", async () => {
    const { providers, disposables } = createGovernanceStack({
      execApprovals: {
        rules: { allow: ["*"], deny: [], ask: [] },
        onAsk: async () => ({ kind: "allow_once" as const }),
      },
    });

    const approvalProvider = findApprovalProvider(providers);
    const agent = createMockAgent({ id: "agent-1" }); // no mailbox
    await approvalProvider?.attach(agent);

    expect(disposables).toHaveLength(0);
  });

  // exec-approvals without onAsk → still creates provider (dynamic handler)
  test("exec-approvals without onAsk → creates provider with dynamic handler", () => {
    const { middlewares, providers } = createGovernanceStack({
      execApprovals: {
        rules: { allow: ["*"], deny: [], ask: [] },
        // no onAsk — will be wired dynamically during assembly
      },
    });
    const ea = middlewares.find((mw) => mw.name === "exec-approvals");
    expect(ea).toBeDefined();
    const approvalProvider = findApprovalProvider(providers);
    expect(approvalProvider).toBeDefined();
  });

  // Disposables are properly disposed
  test("disposables properly clean up on dispose", async () => {
    const mailbox = createMockMailbox();
    const { providers, disposables } = createGovernanceStack({
      execApprovals: {
        rules: { allow: ["*"], deny: [], ask: [] },
        onAsk: async () => ({ kind: "allow_once" as const }),
      },
    });

    const approvalProvider = findApprovalProvider(providers);
    const agent = createMockAgent({ id: "agent-1", mailbox });
    await approvalProvider?.attach(agent);

    // Should not throw
    for (const d of disposables) {
      d[Symbol.dispose]();
    }
    expect(disposables.length).toBeGreaterThanOrEqual(1);
  });

  // No exec-approvals + no providers → zero disposables
  test("no exec-approvals → zero disposables", () => {
    const { disposables } = createGovernanceStack({});
    expect(disposables).toHaveLength(0);
  });
});
