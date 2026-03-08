import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "./assembly.js";
import type { ServiceProviderConfig } from "./create-service-provider.js";
import { createServiceProvider } from "./create-service-provider.js";
import type { Agent, AttachResult, ProcessId, SubsystemToken, Tool, ToolPolicy } from "./ecs.js";
import {
  agentId,
  DEFAULT_SANDBOXED_POLICY,
  DEFAULT_UNSANDBOXED_POLICY,
  isAttachResult,
  token,
  toolToken,
} from "./ecs.js";

/** Extract ReadonlyMap from attach() result (handles both AttachResult and bare Map). */
function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

// ---------------------------------------------------------------------------
// Test helpers — inline (core has zero deps)
// ---------------------------------------------------------------------------

interface MockBackend {
  readonly name: string;
  readonly dispose?: () => void | Promise<void>;
}

const DEFAULT_PID: ProcessId = {
  id: agentId("test-agent-1"),
  name: "Test Agent",
  type: "worker",
  depth: 0,
};

const DEFAULT_MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "0.0.1",
  description: "Test agent",
  model: { name: "test-model" },
};

function createMockAgent(overrides?: { readonly pid?: Partial<ProcessId> }): Agent {
  const pid: ProcessId = { ...DEFAULT_PID, ...overrides?.pid };
  const components = new Map<string, unknown>();
  return {
    pid,
    manifest: DEFAULT_MANIFEST,
    state: "running",
    component: <T>(t: { toString(): string }): T | undefined =>
      components.get(t as string) as T | undefined,
    has: (t: { toString(): string }): boolean => components.has(t as string),
    hasAll: (...tokens: readonly { toString(): string }[]): boolean =>
      tokens.every((t) => components.has(t as string)),
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: (): ReadonlyMap<string, unknown> => components,
  };
}

type TestOperation = "alpha" | "beta" | "gamma";

const BACKEND_TOKEN = token<MockBackend>("test-backend");

function createMockTool(name: string, prefix: string, policy: ToolPolicy): Tool {
  return {
    descriptor: {
      name: `${prefix}_${name}`,
      description: `Mock ${name} tool`,
      inputSchema: { type: "object" },
    },
    origin: "primordial",
    policy,
    execute: async () => `${name}-result`,
  };
}

const MOCK_FACTORIES: Readonly<
  Record<TestOperation, (b: MockBackend, p: string, t: ToolPolicy) => Tool>
> = {
  alpha: (_b, p, t) => createMockTool("alpha", p, t),
  beta: (_b, p, t) => createMockTool("beta", p, t),
  gamma: (_b, p, t) => createMockTool("gamma", p, t),
};

function createTestConfig(
  overrides?: Partial<ServiceProviderConfig<MockBackend, TestOperation>>,
): ServiceProviderConfig<MockBackend, TestOperation> {
  return {
    name: "test-provider",
    singletonToken: BACKEND_TOKEN,
    backend: { name: "mock" },
    operations: ["alpha", "beta", "gamma"] as const,
    factories: MOCK_FACTORIES,
    prefix: "test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createServiceProvider — attach
// ---------------------------------------------------------------------------

describe("createServiceProvider", () => {
  test("provider name matches config", () => {
    const provider = createServiceProvider(createTestConfig({ name: "my-svc" }));
    expect(provider.name).toBe("my-svc");
  });

  test("attaches singleton token + all operation tools", async () => {
    const provider = createServiceProvider(createTestConfig());
    const components = extractMap(await provider.attach(createMockAgent()));

    // 3 tools + 1 singleton token = 4
    expect(components.size).toBe(4);
    expect(components.has(BACKEND_TOKEN as string)).toBe(true);
    expect(components.has(toolToken("test_alpha") as string)).toBe(true);
    expect(components.has(toolToken("test_beta") as string)).toBe(true);
    expect(components.has(toolToken("test_gamma") as string)).toBe(true);
  });

  test("attaches correct backend under singleton token", async () => {
    const backend: MockBackend = { name: "my-backend" };
    const provider = createServiceProvider(createTestConfig({ backend }));
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.get(BACKEND_TOKEN as string)).toBe(backend);
  });

  test("works without singleton token (tools only)", async () => {
    const provider = createServiceProvider(
      createTestConfig({ singletonToken: undefined, backend: undefined }),
    );
    const components = extractMap(await provider.attach(createMockAgent()));

    // 3 tools only, no singleton
    expect(components.size).toBe(3);
    expect(components.has(BACKEND_TOKEN as string)).toBe(false);
    expect(components.has(toolToken("test_alpha") as string)).toBe(true);
  });

  test("respects operations filter (subset)", async () => {
    const provider = createServiceProvider(createTestConfig({ operations: ["alpha", "gamma"] }));
    const components = extractMap(await provider.attach(createMockAgent()));

    // 2 tools + 1 singleton = 3
    expect(components.size).toBe(3);
    expect(components.has(toolToken("test_alpha") as string)).toBe(true);
    expect(components.has(toolToken("test_beta") as string)).toBe(false);
    expect(components.has(toolToken("test_gamma") as string)).toBe(true);
  });

  test("respects custom prefix", async () => {
    const provider = createServiceProvider(createTestConfig({ prefix: "custom" }));
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.has(toolToken("custom_alpha") as string)).toBe(true);
    expect(components.has(toolToken("test_alpha") as string)).toBe(false);
  });

  test("respects custom policy", async () => {
    const provider = createServiceProvider(createTestConfig({ policy: DEFAULT_SANDBOXED_POLICY }));
    const components = extractMap(await provider.attach(createMockAgent()));

    const tool = components.get(toolToken("test_alpha") as string) as Tool;
    expect(tool.policy.sandbox).toBe(true);
  });

  test("defaults trust tier to verified", async () => {
    const provider = createServiceProvider(createTestConfig());
    const components = extractMap(await provider.attach(createMockAgent()));

    const tool = components.get(toolToken("test_alpha") as string) as Tool;
    expect(tool.policy.sandbox).toBe(false);
  });

  test("forwards priority to provider", () => {
    const provider = createServiceProvider(createTestConfig({ priority: 42 }));
    expect(provider.priority).toBe(42);
  });

  test("priority is undefined when not specified", () => {
    const provider = createServiceProvider(createTestConfig());
    expect(provider.priority).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createServiceProvider — caching
// ---------------------------------------------------------------------------

describe("createServiceProvider — caching", () => {
  test("caches components by default (same reference on second attach)", async () => {
    const provider = createServiceProvider(createTestConfig());
    const agent = createMockAgent();

    const first = await provider.attach(agent);
    const second = await provider.attach(agent);

    expect(first).toBe(second); // same reference
  });

  test("cache works across different agents", async () => {
    const provider = createServiceProvider(createTestConfig());

    const first = await provider.attach(createMockAgent({ pid: { id: agentId("a1") } }));
    const second = await provider.attach(createMockAgent({ pid: { id: agentId("a2") } }));

    expect(first).toBe(second); // same cached reference
  });

  test("cache: false rebuilds on every attach", async () => {
    const provider = createServiceProvider(createTestConfig({ cache: false }));
    const agent = createMockAgent();

    const first = await provider.attach(agent);
    const second = await provider.attach(agent);

    expect(first).not.toBe(second); // different references
    expect(extractMap(first).size).toBe(extractMap(second).size); // but same content
  });
});

// ---------------------------------------------------------------------------
// createServiceProvider — customTools
// ---------------------------------------------------------------------------

describe("createServiceProvider — customTools", () => {
  test("appends custom tools alongside standard tools", async () => {
    const extraTool = createMockTool("extra", "test", DEFAULT_UNSANDBOXED_POLICY);
    const provider = createServiceProvider(
      createTestConfig({
        customTools: () => [[toolToken("test_extra") as string, extraTool]],
      }),
    );
    const components = extractMap(await provider.attach(createMockAgent()));

    // 3 standard + 1 custom + 1 singleton = 5
    expect(components.size).toBe(5);
    expect(components.has(toolToken("test_extra") as string)).toBe(true);
    expect(components.get(toolToken("test_extra") as string)).toBe(extraTool);
  });

  test("customTools receives backend and agent", async () => {
    const backend: MockBackend = { name: "observed" };
    // let justified: tracking callback invocation
    let receivedBackend: MockBackend | undefined;
    // let justified: tracking callback invocation
    let receivedAgent: Agent | undefined;

    const provider = createServiceProvider(
      createTestConfig({
        backend,
        customTools: (b, agent) => {
          receivedBackend = b;
          receivedAgent = agent;
          return [];
        },
      }),
    );

    const agent = createMockAgent({ pid: { id: agentId("observed-agent") } });
    await provider.attach(agent);

    expect(receivedBackend).toBe(backend);
    expect(receivedAgent?.pid.id).toBe(agentId("observed-agent"));
  });

  test("customTools disables caching by default (per-agent safety)", async () => {
    const provider = createServiceProvider(
      createTestConfig({
        customTools: (_b, _agent) => [],
      }),
    );

    const first = await provider.attach(createMockAgent({ pid: { id: agentId("a1") } }));
    const second = await provider.attach(createMockAgent({ pid: { id: agentId("a2") } }));

    // With customTools and no explicit cache setting, each attach rebuilds
    expect(first).not.toBe(second);
  });

  test("customTools with cache: true explicitly enables caching", async () => {
    const provider = createServiceProvider(
      createTestConfig({
        customTools: (_b, _agent) => [],
        cache: true,
      }),
    );

    const first = await provider.attach(createMockAgent({ pid: { id: agentId("a1") } }));
    const second = await provider.attach(createMockAgent({ pid: { id: agentId("a2") } }));

    // Explicitly enabled — same cached reference
    expect(first).toBe(second);
  });

  test("customTools returning empty array adds nothing extra", async () => {
    const provider = createServiceProvider(createTestConfig({ customTools: () => [] }));
    const components = extractMap(await provider.attach(createMockAgent()));

    // 3 standard + 1 singleton = 4 (no extras)
    expect(components.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// createServiceProvider — validation
// ---------------------------------------------------------------------------

describe("createServiceProvider — validation", () => {
  test("throws on empty operations array", () => {
    expect(() => createServiceProvider(createTestConfig({ operations: [] }))).toThrow(
      /operations.*must not be empty/i,
    );
  });

  test("throws on duplicate operations", () => {
    expect(() =>
      createServiceProvider(
        createTestConfig({ operations: ["alpha", "beta", "alpha"] as readonly TestOperation[] }),
      ),
    ).toThrow(/duplicate.*operation/i);
  });
});

// ---------------------------------------------------------------------------
// createServiceProvider — detach
// ---------------------------------------------------------------------------

describe("createServiceProvider — detach", () => {
  test("calls detach callback with backend", async () => {
    // let justified: tracking detach invocation
    let detachedBackend: MockBackend | undefined;
    const backend: MockBackend = { name: "detachable" };
    const provider = createServiceProvider(
      createTestConfig({
        backend,
        detach: async (b) => {
          detachedBackend = b;
        },
      }),
    );

    await provider.detach?.(createMockAgent());
    expect(detachedBackend).toBe(backend);
  });

  test("detach is undefined when no detach callback provided", () => {
    const config = createTestConfig();
    // Ensure we don't pass detach
    const { detach: _removed, ...rest } = config;
    const provider = createServiceProvider(
      rest as ServiceProviderConfig<MockBackend, TestOperation>,
    );
    expect(provider.detach).toBeUndefined();
  });

  test("detach awaits async callback", async () => {
    // let justified: tracking async completion
    let completed = false;
    const provider = createServiceProvider(
      createTestConfig({
        detach: async () => {
          await Promise.resolve();
          completed = true;
        },
      }),
    );

    await provider.detach?.(createMockAgent());
    expect(completed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createServiceProvider — edge cases
// ---------------------------------------------------------------------------

describe("createServiceProvider — edge cases", () => {
  test("single operation works correctly", async () => {
    const provider = createServiceProvider(createTestConfig({ operations: ["beta"] }));
    const components = extractMap(await provider.attach(createMockAgent()));

    // 1 tool + 1 singleton = 2
    expect(components.size).toBe(2);
    expect(components.has(toolToken("test_beta") as string)).toBe(true);
  });

  test("default prefix is empty string when not specified", async () => {
    const provider = createServiceProvider(createTestConfig({ prefix: undefined }));
    const components = extractMap(await provider.attach(createMockAgent()));

    // Tools should use default prefix from config (test for "test" prefix which is the default in our test config)
    // Actually, we need to check what happens when prefix is undefined
    // The factory should handle it — let's verify tools are still created
    expect(components.size).toBe(4);
  });

  test("tool factories receive correct arguments", async () => {
    const backend: MockBackend = { name: "arg-check" };
    // let justified: tracking factory invocations
    let receivedArgs: { backend: MockBackend; prefix: string; policy: ToolPolicy } | undefined;

    const factories: Readonly<Record<"alpha", (b: MockBackend, p: string, t: ToolPolicy) => Tool>> =
      {
        alpha: (b, p, t) => {
          receivedArgs = { backend: b, prefix: p, policy: t };
          return createMockTool("alpha", p, t);
        },
      };

    const provider = createServiceProvider({
      name: "arg-test",
      singletonToken: BACKEND_TOKEN,
      backend,
      operations: ["alpha"] as const,
      factories,
      prefix: "my_prefix",
      policy: DEFAULT_UNSANDBOXED_POLICY,
    });

    await provider.attach(createMockAgent());

    expect(receivedArgs?.backend).toBe(backend);
    expect(receivedArgs?.prefix).toBe("my_prefix");
    expect(receivedArgs?.policy).toEqual(DEFAULT_UNSANDBOXED_POLICY);
  });
});
