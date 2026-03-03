/**
 * Content-level tests for procfs entry definitions.
 *
 * Uses a known Agent fixture with all components attached.
 * Asserts exact shape/content of each read result.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentEnv,
  AgentId,
  AgentManifest,
  AgentRegistry,
  KoiError,
  KoiMiddleware,
  MailboxComponent,
  PatchableRegistryFields,
  ProcessId,
  RegistryEntry,
  RegistryFilter,
  Result,
  ScratchpadComponent,
  SubsystemToken,
  Tool,
  ToolDescriptor,
  WorkspaceComponent,
} from "@koi/core";
import { agentId, ENV, MAILBOX, messageId, SCRATCHPAD, WORKSPACE } from "@koi/core";
import type { EntryContext } from "../entry-definitions.js";
import { PROCFS_ENTRIES } from "../entry-definitions.js";
import { createEntriesFromDefinitions } from "../entry-factory.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = agentId("agent-test-001");

// ---------------------------------------------------------------------------
// Mock agent with components
// ---------------------------------------------------------------------------

function createToolDescriptor(name: string, desc: string): ToolDescriptor {
  return { name, description: desc, inputSchema: {} };
}

function createFullAgent(): Agent {
  const pid: ProcessId = { id: TEST_AGENT_ID, name: "test-agent", type: "worker", depth: 0 };
  const manifest: AgentManifest = {
    name: "test-agent",
    version: "1.0.0",
    description: "A test agent for procfs",
    model: { name: "claude-sonnet-4-5-20250514" },
    lifecycle: "worker",
  };

  const envValues: Readonly<Record<string, string>> = { FOO: "bar", DEBUG: "true" };
  const mockEnv: AgentEnv = { values: envValues };

  const mockWorkspace: WorkspaceComponent = {
    id: "ws-001" as ReturnType<typeof import("@koi/core").workspaceId>,
    path: "/tmp/workspace-001",
    createdAt: 1700000000000,
    metadata: { owner: "test" },
  };

  const mockMailbox: MailboxComponent = {
    send: () => Promise.resolve({ ok: true, value: {} } as never),
    onMessage: () => () => {},
    list: () => [
      {
        id: messageId("msg-1"),
        from: agentId("sender"),
        to: TEST_AGENT_ID,
        kind: "request" as const,
        createdAt: "2023-11-14T22:13:20.000Z",
        type: "text",
        payload: { text: "hello" },
      },
    ],
  };

  const mockScratchpad: ScratchpadComponent = {
    write: () => ({ ok: true, value: { path: "f.txt", version: 1 } }) as never,
    read: () => ({ ok: true, value: {} }) as never,
    list: () => [
      {
        path: "notes.md" as never,
        generation: 1,
        sizeBytes: 42,
        updatedAt: "2023-11-14T22:13:20.000Z",
        groupId: "test-group" as never,
        authorId: agentId("test"),
        createdAt: "2023-11-14T22:13:20.000Z",
      },
    ],
    delete: () => ({ ok: true, value: undefined }) as never,
    flush: () => {},
    onChange: () => () => {},
  };

  // Tools
  const tool1: Tool = {
    descriptor: createToolDescriptor("search", "Search the web"),
    execute: () => Promise.resolve({ output: "result" }),
    trustTier: "sandbox",
  };
  const tool2: Tool = {
    descriptor: createToolDescriptor("write_file", "Write a file"),
    execute: () => Promise.resolve({ output: "ok" }),
    trustTier: "verified",
  };

  // Middleware
  const mw1: KoiMiddleware = { name: "audit-logger", describeCapabilities: () => undefined };
  const mw2: KoiMiddleware = { name: "rate-limiter", describeCapabilities: () => undefined };

  // Component storage
  const components = new Map<string, unknown>();
  components.set("tool:search", tool1);
  components.set("tool:write_file", tool2);
  components.set("middleware:audit-logger", mw1);
  components.set("middleware:rate-limiter", mw2);
  components.set(ENV as string, mockEnv);
  components.set(WORKSPACE as string, mockWorkspace);
  components.set(MAILBOX as string, mockMailbox);
  components.set(SCRATCHPAD as string, mockScratchpad);

  return {
    pid,
    manifest,
    state: "running",
    component: <T>(token: SubsystemToken<T>): T | undefined =>
      components.get(token as string) as T | undefined,
    has: (token: SubsystemToken<unknown>) => components.has(token as string),
    hasAll: (...tokens: readonly SubsystemToken<unknown>[]) =>
      tokens.every((t) => components.has(t as string)),
    query: <T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> => {
      const result = new Map<SubsystemToken<T>, T>();
      for (const [key, value] of components) {
        if (key.startsWith(prefix)) {
          result.set(key as SubsystemToken<T>, value as T);
        }
      }
      return result;
    },
    components: () => components as ReadonlyMap<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Mock registry with data
// ---------------------------------------------------------------------------

function createMockRegistry(): AgentRegistry {
  const registeredEntry: RegistryEntry = {
    agentId: TEST_AGENT_ID,
    status: {
      phase: "running",
      generation: 3,
      conditions: ["Ready", "Healthy"],
      lastTransitionAt: 1700000000000,
    },
    agentType: "worker",
    metadata: {},
    registeredAt: 1699999000000,
    priority: 5,
  };

  const childEntry: RegistryEntry = {
    agentId: agentId("child-001"),
    status: {
      phase: "running",
      generation: 1,
      conditions: [],
      lastTransitionAt: 1700000000000,
    },
    agentType: "worker",
    metadata: {},
    registeredAt: 1700000000000,
    parentId: TEST_AGENT_ID,
    priority: 10,
  };

  let lastPatchedPriority = 5; // let: mutated by patch()

  return {
    register: (e) => e,
    deregister: () => true,
    lookup: (id) => {
      if (id === TEST_AGENT_ID) {
        return { ...registeredEntry, priority: lastPatchedPriority };
      }
      return undefined;
    },
    list: (filter?: RegistryFilter) => {
      if (filter?.parentId === TEST_AGENT_ID) return [childEntry];
      return [registeredEntry, childEntry];
    },
    transition: (): Result<RegistryEntry, KoiError> => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "mock", retryable: false },
    }),
    patch: (_id: AgentId, fields: PatchableRegistryFields): Result<RegistryEntry, KoiError> => {
      if (fields.priority !== undefined) {
        lastPatchedPriority = fields.priority;
      }
      return { ok: true, value: { ...registeredEntry, priority: lastPatchedPriority } };
    },
    watch: () => () => {},
    descriptor: (id) => {
      if (id === TEST_AGENT_ID) {
        return {
          agentId: TEST_AGENT_ID,
          state: "running" as const,
          conditions: ["Ready", "Healthy"] as const,
          generation: 3,
          registeredAt: 1699999000000,
        };
      }
      return undefined;
    },
    [Symbol.asyncDispose]: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("procfs entry content", () => {
  let ctx: EntryContext;

  beforeEach(() => {
    ctx = {
      agent: createFullAgent(),
      agentId: TEST_AGENT_ID,
      registry: createMockRegistry(),
    };
  });

  // Helper to get entry by path
  function getEntry(path: string): ReturnType<typeof createEntriesFromDefinitions>[number] {
    const entries = createEntriesFromDefinitions(PROCFS_ENTRIES, ctx);
    const found = entries.find((e) => e.path === path);
    if (found === undefined) throw new Error(`Entry not found: ${path}`);
    return found;
  }

  // -----------------------------------------------------------------------
  // status
  // -----------------------------------------------------------------------

  test("status returns pid, state, and terminationOutcome", async () => {
    const result = await getEntry("status").entry.read();
    expect(result).toEqual({
      pid: ctx.agent.pid,
      state: "running",
      terminationOutcome: undefined,
    });
  });

  // -----------------------------------------------------------------------
  // metrics
  // -----------------------------------------------------------------------

  test("metrics returns registry-derived agent metrics", async () => {
    const result = await getEntry("metrics").entry.read();
    expect(result).toEqual({
      priority: 5,
      generation: 3,
      phase: "running",
      conditions: ["Ready", "Healthy"],
      registeredAt: 1699999000000,
    });
  });

  test("metrics write updates priority via registry patch", async () => {
    const entry = getEntry("metrics").entry;
    if (!("write" in entry)) throw new Error("metrics should be writable");
    await entry.write({ priority: 2 });
    const result = await entry.read();
    expect(result).toEqual(expect.objectContaining({ priority: 2 }));
  });

  // -----------------------------------------------------------------------
  // tools
  // -----------------------------------------------------------------------

  test("tools returns tool descriptors", async () => {
    const result = (await getEntry("tools").entry.read()) as readonly unknown[];
    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "search", trustTier: "sandbox" }),
        expect.objectContaining({ name: "write_file", trustTier: "verified" }),
      ]),
    );
  });

  test("tools list returns token strings", async () => {
    const list = await getEntry("tools").entry.list?.();
    expect(list).toHaveLength(2);
    expect(list).toEqual(expect.arrayContaining(["tool:search", "tool:write_file"]));
  });

  // -----------------------------------------------------------------------
  // middleware
  // -----------------------------------------------------------------------

  test("middleware returns middleware names", async () => {
    const result = (await getEntry("middleware").entry.read()) as readonly unknown[];
    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "audit-logger" }),
        expect.objectContaining({ name: "rate-limiter" }),
      ]),
    );
  });

  test("middleware list returns token strings", async () => {
    const list = await getEntry("middleware").entry.list?.();
    expect(list).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // children
  // -----------------------------------------------------------------------

  test("children returns child agent metadata", async () => {
    const result = (await getEntry("children").entry.read()) as readonly unknown[];
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      agentId: "child-001",
      agentType: "worker",
      phase: "running",
      priority: 10,
    });
  });

  test("children list returns child agent IDs", async () => {
    const list = await getEntry("children").entry.list?.();
    expect(list).toEqual(["child-001"]);
  });

  // -----------------------------------------------------------------------
  // config
  // -----------------------------------------------------------------------

  test("config returns manifest data", async () => {
    const result = await getEntry("config").entry.read();
    expect(result).toEqual({
      name: "test-agent",
      description: "A test agent for procfs",
      model: { name: "claude-sonnet-4-5-20250514" },
      lifecycle: "worker",
    });
  });

  // -----------------------------------------------------------------------
  // env
  // -----------------------------------------------------------------------

  test("env returns environment values", async () => {
    const result = await getEntry("env").entry.read();
    expect(result).toEqual({ FOO: "bar", DEBUG: "true" });
  });

  test("env list returns environment keys", async () => {
    const list = await getEntry("env").entry.list?.();
    expect(list).toEqual(expect.arrayContaining(["FOO", "DEBUG"]));
  });

  // -----------------------------------------------------------------------
  // descriptor (new)
  // -----------------------------------------------------------------------

  test("descriptor returns ProcessDescriptor from registry", async () => {
    const result = await getEntry("descriptor").entry.read();
    expect(result).toEqual({
      agentId: TEST_AGENT_ID,
      state: "running",
      conditions: ["Ready", "Healthy"],
      generation: 3,
      registeredAt: 1699999000000,
    });
  });

  // -----------------------------------------------------------------------
  // signals (new)
  // -----------------------------------------------------------------------

  test("signals returns AGENT_SIGNALS constant", async () => {
    const result = await getEntry("signals").entry.read();
    expect(result).toEqual({
      STOP: "stop",
      CONT: "cont",
      TERM: "term",
      USR1: "usr1",
      USR2: "usr2",
    });
  });

  // -----------------------------------------------------------------------
  // mailbox (new)
  // -----------------------------------------------------------------------

  test("mailbox returns message list from component", async () => {
    const result = (await getEntry("mailbox").entry.read()) as readonly unknown[];
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ id: "msg-1", from: "sender" }));
  });

  // -----------------------------------------------------------------------
  // scratchpad (new)
  // -----------------------------------------------------------------------

  test("scratchpad returns entry summaries from component", async () => {
    const result = (await getEntry("scratchpad").entry.read()) as readonly unknown[];
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ path: "notes.md", generation: 1 }));
  });

  // -----------------------------------------------------------------------
  // workspace (new)
  // -----------------------------------------------------------------------

  test("workspace returns workspace info from component", async () => {
    const result = await getEntry("workspace").entry.read();
    expect(result).toEqual({
      id: "ws-001",
      path: "/tmp/workspace-001",
      createdAt: 1700000000000,
      metadata: { owner: "test" },
    });
  });

  // -----------------------------------------------------------------------
  // Missing component handling
  // -----------------------------------------------------------------------

  describe("handles missing components gracefully", () => {
    beforeEach(() => {
      // Agent with NO components attached
      const bareAgent: Agent = {
        pid: { id: TEST_AGENT_ID, name: "bare", type: "worker", depth: 0 },
        manifest: { name: "bare", version: "1.0.0", model: { name: "test" } } as AgentManifest,
        state: "created",
        component: () => undefined,
        has: () => false,
        hasAll: () => false,
        query: () => new Map(),
        components: () => new Map(),
      };
      ctx = { agent: bareAgent, agentId: TEST_AGENT_ID, registry: createMockRegistry() };
    });

    test("env returns empty object when ENV component missing", async () => {
      const result = await getEntry("env").entry.read();
      expect(result).toEqual({});
    });

    test("env list returns empty array when ENV component missing", async () => {
      const list = await getEntry("env").entry.list?.();
      expect(list).toEqual([]);
    });

    test("tools returns empty array when no tools attached", async () => {
      const result = await getEntry("tools").entry.read();
      expect(result).toEqual([]);
    });

    test("middleware returns empty array when no middleware attached", async () => {
      const result = await getEntry("middleware").entry.read();
      expect(result).toEqual([]);
    });

    test("mailbox returns undefined when MAILBOX component missing", async () => {
      const result = await getEntry("mailbox").entry.read();
      expect(result).toBeUndefined();
    });

    test("scratchpad returns undefined when SCRATCHPAD component missing", async () => {
      const result = await getEntry("scratchpad").entry.read();
      expect(result).toBeUndefined();
    });

    test("workspace returns undefined when WORKSPACE component missing", async () => {
      const result = await getEntry("workspace").entry.read();
      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // All entries enumerable
  // -----------------------------------------------------------------------

  test("PROCFS_ENTRIES contains 12 entry definitions", () => {
    expect(PROCFS_ENTRIES).toHaveLength(12);
  });

  test("all 12 entries are created by factory", () => {
    const entries = createEntriesFromDefinitions(PROCFS_ENTRIES, ctx);
    expect(entries).toHaveLength(12);
    const paths = entries.map((e) => e.path);
    expect(paths).toEqual([
      "status",
      "metrics",
      "tools",
      "middleware",
      "children",
      "config",
      "env",
      "descriptor",
      "signals",
      "mailbox",
      "scratchpad",
      "workspace",
    ]);
  });
});
