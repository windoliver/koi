import { beforeAll, describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { NexusHealth, NexusTransport } from "@koi/nexus-client";
import { computeAgentNamespace, computeGroupNamespace } from "./namespace.js";
import type { GlobalBackendFactories, NexusBundle, NexusStackConfig } from "./types.js";

// File is named `aaa-*` so bun discovers it before `nexus-stack.test.ts`:
// that sibling uses `mock.module()` to stub deps, and bun's module mocks
// persist across the whole test process, so this suite must run first to
// observe real implementations. nexus-stack.test.ts also calls
// `mock.restore()` in afterAll as belt-and-braces. Re-import nexus-stack
// dynamically in beforeAll for extra safety against stale module bindings.
let createNexusStack: (config: NexusStackConfig) => Promise<NexusBundle>;

beforeAll(async () => {
  const mod = await import(`./nexus-stack.js?integration=${Date.now()}-${Math.random()}`);
  createNexusStack = mod.createNexusStack;
});

type MakeTransportOpts = {
  readonly health?: () => Promise<Result<NexusHealth, KoiError>>;
};

function makeTransport(opts: MakeTransportOpts = {}): NexusTransport {
  return {
    kind: "http",
    call: async <T>(): Promise<Result<T, KoiError>> => ({
      ok: true,
      value: {} as T,
    }),
    close: () => {},
    ...(opts.health !== undefined ? { health: opts.health } : {}),
  };
}

const okHealth = async (): Promise<Result<NexusHealth, KoiError>> => ({
  ok: true,
  value: { status: "ok", version: "1", latencyMs: 1, probed: [] },
});

const failHealth = async (): Promise<Result<NexusHealth, KoiError>> => ({
  ok: false,
  error: {
    code: "UNAVAILABLE",
    message: "transport down",
    retryable: false,
  } satisfies KoiError,
});

const missingPathsHealth = async (): Promise<Result<NexusHealth, KoiError>> => ({
  ok: true,
  value: {
    status: "missing-paths",
    version: "1",
    latencyMs: 1,
    probed: ["/a"],
    notFound: ["/b"],
  },
});

function tagged(kind: string) {
  return (id: string) => ({ kind, id });
}

const factories: GlobalBackendFactories = {
  registry: () => ({ kind: "registry" }),
  permissions: () => ({ kind: "permissions" }),
  audit: () => ({ kind: "audit" }),
  search: () => ({ kind: "search" }),
  scheduler: () => ({ kind: "scheduler" }),
};

const fullAgent: NexusStackConfig["agentProvider"] = {
  createFileSystem: tagged("fs"),
  createMailbox: async (id) => ({ kind: "mailbox", id }),
  createSnapshotStore: tagged("snap"),
  createPlaybookStore: tagged("play"),
  createHandoffStore: tagged("handoff"),
  createScratchpad: (id) => ({ kind: "scratchpad", id }),
  createWorkspace: async (id) => ({ kind: "workspace", id }),
};

function baseConfig(overrides: Partial<NexusStackConfig> = {}): NexusStackConfig {
  return {
    transport: makeTransport({ health: okHealth }),
    enableScratchpad: true,
    enableWorkspace: true,
    global: { registry: true, permissions: true, audit: true, search: true, scheduler: true },
    globalFactories: factories,
    agentProvider: fullAgent,
    ...overrides,
  };
}

describe("@koi/nexus integration — happy path", () => {
  test("Case 1: Nexus healthy, all backends + 7 components attach in nexus mode", async () => {
    const bundle = await createNexusStack(baseConfig());
    expect(bundle.backends.registry).toBeDefined();
    expect(bundle.backends.permissions).toBeDefined();
    expect(bundle.backends.audit).toBeDefined();
    expect(bundle.backends.search).toBeDefined();
    expect(bundle.backends.scheduler).toBeDefined();
    expect(bundle.config.fallbackActive).toBe(false);

    const attached = await bundle.providers[0]!.attach({
      pid: { id: "a1", groupId: "g1" },
    });
    expect(attached.components.size).toBe(7);
    expect(attached.skipped).toEqual([]);

    for (const f of Object.values(bundle.features)) {
      if (f.enabled) expect(f.mode).toBe("nexus");
    }
  });
});

describe("@koi/nexus integration — fallback transitions", () => {
  test("Case 2: transport unhealthy at startup with fallback configured → fallback mode", async () => {
    const bundle = await createNexusStack(
      baseConfig({
        transport: makeTransport({ health: failHealth }),
        fallback: {
          globalFactories: { audit: () => ({ kind: "local-audit" }) },
          agentProvider: { createFileSystem: tagged("local-fs") },
        },
      }),
    );
    expect(bundle.config.fallbackActive).toBe(true);
    expect(bundle.features.audit?.mode).toBe("fallback");
    // No fallback factory provided → unavailable
    expect(bundle.features.registry?.mode).toBe("unavailable");
    const snap = await bundle.health();
    expect(snap.status).toBe("degraded");
    expect(snap.dashboard.summary).toContain("local fallback active");
  });

  test("Case 3: transport unhealthy with NO fallback → unhealthy, no fallback active", async () => {
    const bundle = await createNexusStack(
      baseConfig({ transport: makeTransport({ health: failHealth }) }),
    );
    expect(bundle.config.fallbackActive).toBe(false);
    const snap = await bundle.health();
    expect(snap.status).toBe("unhealthy");
    expect(snap.dashboard.summary).toContain("Nexus transport unhealthy");
  });

  test("Case 4: transport reachable but missing paths → degraded", async () => {
    const bundle = await createNexusStack(
      baseConfig({ transport: makeTransport({ health: missingPathsHealth }) }),
    );
    const snap = await bundle.health();
    expect(snap.status).toBe("degraded");
    expect(snap.dashboard.summary).toContain("missing probe paths");
  });

  test("Case 5: dynamic health flips after construction", async () => {
    let healthy = true;
    const dynamicHealth = async (): Promise<Result<NexusHealth, KoiError>> =>
      healthy ? okHealth() : failHealth();
    const bundle = await createNexusStack(
      baseConfig({ transport: makeTransport({ health: dynamicHealth }) }),
    );
    expect((await bundle.health()).status).toBe("ok");
    healthy = false;
    expect((await bundle.health()).status).toBe("unhealthy");
    healthy = true;
    expect((await bundle.health()).status).toBe("ok");
  });
});

describe("@koi/nexus integration — backend selection", () => {
  test("Case 6: per-backend disable flags omit factories and mark disabled", async () => {
    let auditCalled = 0;
    const localFactories: GlobalBackendFactories = {
      ...factories,
      audit: () => {
        auditCalled++;
        return { kind: "audit" };
      },
    };
    const bundle = await createNexusStack(
      baseConfig({
        global: { registry: true, permissions: true, audit: false, search: true, scheduler: true },
        globalFactories: localFactories,
      }),
    );
    expect(bundle.backends.audit).toBeUndefined();
    expect(auditCalled).toBe(0);
    expect(bundle.features.audit?.mode).toBe("disabled");
    expect(bundle.features.audit?.enabled).toBe(false);
  });

  test("Case 7: subset enabled — disabled factories never invoked", async () => {
    const calls: string[] = [];
    const tracked: GlobalBackendFactories = {
      registry: () => (calls.push("registry"), {}),
      permissions: () => (calls.push("permissions"), {}),
      audit: () => (calls.push("audit"), {}),
      search: () => (calls.push("search"), {}),
      scheduler: () => (calls.push("scheduler"), {}),
    };
    await createNexusStack(
      baseConfig({
        global: {
          registry: true,
          permissions: false,
          audit: false,
          search: true,
          scheduler: false,
        },
        globalFactories: tracked,
      }),
    );
    expect(calls.sort()).toEqual(["registry", "search"]);
  });
});

describe("@koi/nexus integration — agent provider edge cases", () => {
  test("Case 8: scratchpad enabled but agent has no groupId → component absent, skipped", async () => {
    const bundle = await createNexusStack(baseConfig());
    const attached = await bundle.providers[0]!.attach({ pid: { id: "agent-only" } });
    expect(attached.components.has("scratchpad")).toBe(false);
    expect(attached.skipped).toContain("scratchpad");
  });

  test("Case 9: workspace disabled → factory not called even if provided", async () => {
    let workspaceCalled = 0;
    const bundle = await createNexusStack(
      baseConfig({
        enableWorkspace: false,
        agentProvider: {
          ...fullAgent,
          createWorkspace: async (id) => {
            workspaceCalled++;
            return { kind: "workspace", id };
          },
        },
      }),
    );
    const attached = await bundle.providers[0]!.attach({
      pid: { id: "a1", groupId: "g1" },
    });
    expect(attached.components.has("workspace")).toBe(false);
    expect(workspaceCalled).toBe(0);
    expect(bundle.features.workspace?.mode).toBe("disabled");
  });

  test("Case 10: missing factory → component skipped without throw", async () => {
    const bundle = await createNexusStack(
      baseConfig({
        agentProvider: { ...fullAgent, createFileSystem: undefined },
      }),
    );
    expect(bundle.features.filesystem?.mode).toBe("unavailable");
    const attached = await bundle.providers[0]!.attach({
      pid: { id: "a1", groupId: "g1" },
    });
    expect(attached.components.has("filesystem")).toBe(false);
    expect(attached.skipped).toContain("filesystem");
  });

  test("Case 11: two agents in same group share scratchpad namespace", async () => {
    const groupCalls: string[] = [];
    const bundle = await createNexusStack(
      baseConfig({
        agentProvider: {
          ...fullAgent,
          createScratchpad: (id) => {
            groupCalls.push(id);
            return { kind: "scratchpad", id };
          },
        },
      }),
    );
    const a1 = await bundle.providers[0]!.attach({ pid: { id: "agent-A", groupId: "team-7" } });
    const a2 = await bundle.providers[0]!.attach({ pid: { id: "agent-B", groupId: "team-7" } });
    expect(groupCalls).toEqual(["team-7", "team-7"]);
    expect(a1.components.get("scratchpad")).toBeDefined();
    expect(a2.components.get("scratchpad")).toBeDefined();
    expect(computeGroupNamespace("team-7").scratchpad).toBe("groups/team-7/scratchpad");
  });

  test("Case 12: concurrent attach for distinct agents — no shared state leak", async () => {
    const seen: string[] = [];
    const bundle = await createNexusStack(
      baseConfig({
        agentProvider: {
          ...fullAgent,
          createMailbox: async (id) => {
            seen.push(id);
            return { kind: "mailbox", id };
          },
        },
      }),
    );
    const ids = ["a", "b", "c", "d"];
    const results = await Promise.all(
      ids.map((id) => bundle.providers[0]!.attach({ pid: { id, groupId: "g" } })),
    );
    expect(seen.sort()).toEqual(["a", "b", "c", "d"]);
    for (const [i, r] of results.entries()) {
      const mb = r.components.get("mailbox") as { id: string };
      expect(mb.id).toBe(ids[i]!);
    }
  });
});

describe("@koi/nexus integration — lifecycle", () => {
  test("Case 13: dispose runs all disposers, idempotent on second call", async () => {
    let disposeCount = 0;
    const bundle = await createNexusStack(
      baseConfig({ dispose: [() => void disposeCount++, () => void disposeCount++] }),
    );
    await bundle.dispose();
    expect(disposeCount).toBe(2);
    await bundle.dispose();
    expect(disposeCount).toBe(4); // disposers re-run; no throw
  });

  test("Case 14: disposer that throws surfaces the error", async () => {
    const bundle = await createNexusStack(
      baseConfig({
        dispose: [
          () => {
            throw new Error("boom");
          },
        ],
      }),
    );
    let caught: unknown;
    try {
      await bundle.dispose();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
  });
});

describe("@koi/nexus integration — namespace stability", () => {
  test("Case 15: agent namespace is deterministic per agent id", () => {
    const ns = computeAgentNamespace("agent-xyz");
    expect(ns.filesystem).toBe("agents/agent-xyz/filesystem");
    expect(ns.mailbox).toBe("agents/agent-xyz/mailbox");
    expect(ns.snapshotStore).toBe("agents/agent-xyz/snapshots");
    expect(ns.playbooks).toBe("agents/agent-xyz/playbooks");
    expect(ns.handoffs).toBe("agents/agent-xyz/handoffs");
  });

  test("Case 16: distinct agents get distinct namespaces", () => {
    const a = computeAgentNamespace("agent-1");
    const b = computeAgentNamespace("agent-2");
    expect(a.filesystem).not.toBe(b.filesystem);
  });
});

describe("@koi/nexus integration — dashboard surface", () => {
  test("Case 17: dashboard rows include transport probe + per-feature rows", async () => {
    const bundle = await createNexusStack(baseConfig());
    const dash = await bundle.dashboard();
    expect(dash.rows[0]?.key).toBe("transport");
    const keys = dash.rows.map((r) => r.key);
    expect(keys).toContain("registry");
    expect(keys).toContain("filesystem");
    expect(keys).toContain("scratchpad");
    expect(keys).toContain("workspace");
    expect(dash.status).toBe("ok");
  });

  test("Case 18: feature snapshot exposes sourcePackage per L2 origin", async () => {
    const bundle = await createNexusStack(baseConfig());
    expect(bundle.features.registry?.sourcePackage).toBe("@koi/registry-nexus");
    expect(bundle.features.filesystem?.sourcePackage).toBe("@koi/fs-nexus");
    expect(bundle.features["handoff-store"]?.sourcePackage).toBe("@koi/handoff");
    expect(bundle.features.scratchpad?.sourcePackage).toBe("@koi/scratchpad-nexus");
    expect(bundle.features.workspace?.sourcePackage).toBe("@koi/workspace-nexus");
  });
});
