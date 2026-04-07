/**
 * Contract tests — MCP protocol round-trip via InMemoryTransport.
 *
 * Tests the full server lifecycle: connection, tools/list, tools/call,
 * hot-reload, error handling, and platform tool gating.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  Agent,
  AgentMessage,
  AgentRegistry,
  JsonObject,
  KoiError,
  MailboxComponent,
  ManagedTaskBoard,
  RegistryEntry,
  Result,
  Task,
  TaskBoard,
  TaskItemId,
  TaskResult,
  Tool,
} from "@koi/core";
import { agentId, toolToken } from "@koi/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "../server.js";
import { createMcpServer } from "../server.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockTool(
  name: string,
  description: string,
  handler?: (args: JsonObject) => Promise<unknown>,
): Tool {
  return {
    descriptor: {
      name,
      description,
      inputSchema: { type: "object", properties: {} },
      origin: "primordial",
    },
    origin: "primordial",
    policy: { sandbox: false, capabilities: {} },
    execute: handler ?? (async () => `${name} result`),
  };
}

function createMockAgent(tools: readonly Tool[] = []): Agent {
  const toolMap = new Map<string, Tool>();
  for (const t of tools) {
    toolMap.set(toolToken(t.descriptor.name), t);
  }
  return {
    manifest: { name: "test-agent", version: "0.0.0", description: "test" },
    component: (token: string) => toolMap.get(token),
    has: (token: string) => toolMap.has(token),
    hasAll: (...tokens: readonly string[]) => tokens.every((t) => toolMap.has(t)),
    query: <T>(prefix: string) => {
      const result = new Map<string, T>();
      for (const [k, v] of toolMap) {
        if (k.startsWith(prefix)) result.set(k, v as T);
      }
      return result;
    },
    components: () => toolMap as ReadonlyMap<string, unknown>,
  } as unknown as Agent;
}

function createMockMailbox(): MailboxComponent {
  const messages: AgentMessage[] = [];
  return {
    send: mock(async (input: unknown) => {
      const msg = {
        ...(input as Record<string, unknown>),
        id: `msg-${messages.length + 1}`,
        createdAt: new Date().toISOString(),
      } as unknown as AgentMessage;
      messages.push(msg);
      return { ok: true, value: msg } as Result<AgentMessage, KoiError>;
    }),
    onMessage: () => () => {},
    list: mock(async () => messages),
  };
}

function createMockTask(id: string, status: string, assignedTo?: string): Task {
  return {
    id: id as TaskItemId,
    subject: `Task ${id}`,
    description: `Description for ${id}`,
    dependencies: [],
    status: status as Task["status"],
    assignedTo: assignedTo !== undefined ? agentId(assignedTo) : undefined,
    retries: 0,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function createMockTaskBoard(tasks: readonly Task[] = []): ManagedTaskBoard {
  const taskMap = new Map<string, Task>();
  const results = new Map<string, TaskResult>();
  for (const t of tasks) taskMap.set(t.id, t);

  const board: TaskBoard = {
    get: (id: TaskItemId) => taskMap.get(id),
    all: () => [...taskMap.values()],
    pending: () => [...taskMap.values()].filter((t) => t.status === "pending"),
    inProgress: () => [...taskMap.values()].filter((t) => t.status === "in_progress"),
    completed: () => [],
    failed: () => [...taskMap.values()].filter((t) => t.status === "failed"),
    killed: () => [],
    ready: () => [],
    blocked: () => [],
    unreachable: () => [],
    dependentsOf: () => [],
    size: () => taskMap.size,
    result: (id: TaskItemId) => results.get(id),
    add: () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    addAll: () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    assign: () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    unassign: () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    complete: () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    fail: () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    kill: () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    update: () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
  };

  return {
    snapshot: () => board,
    nextId: async () => `task-new` as TaskItemId,
    add: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    addAll: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    assign: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    unassign: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    startTask: mock(async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>),
    hasResultPersistence: () => true,
    complete: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    completeOwnedTask: mock(
      async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    ),
    fail: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    failOwnedTask: mock(async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>),
    kill: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    killOwnedTask: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    update: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    updateOwned: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    [Symbol.asyncDispose]: async () => {},
  } as unknown as ManagedTaskBoard;
}

function createMockRegistry(entries: readonly Partial<RegistryEntry>[] = []): AgentRegistry {
  return {
    register: async () => ({}) as RegistryEntry,
    deregister: async () => true,
    lookup: async () => undefined,
    list: mock(
      async () =>
        entries.map((e) => ({
          agentId: e.agentId ?? agentId("agent-1"),
          agentType: e.agentType ?? "worker",
          status: e.status ?? { phase: "running", generation: 1, conditions: [] },
          registeredAt: e.registeredAt ?? Date.now(),
          parentId: e.parentId ?? undefined,
          metadata: {},
        })) as unknown as readonly RegistryEntry[],
    ),
    transition: async () => ({ ok: true, value: {} }) as unknown as Result<RegistryEntry, KoiError>,
    patch: async () => ({ ok: true, value: {} }) as unknown as Result<RegistryEntry, KoiError>,
    watch: () => () => {},
    [Symbol.asyncDispose]: async () => {},
  } as unknown as AgentRegistry;
}

async function createTestPair(
  config: Parameters<typeof createMcpServer>[0],
): Promise<{ server: McpServer; client: Client }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ ...config, transport: serverTransport });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.start();
  await client.connect(clientTransport);
  return { server, client };
}

const CALLER_ID = agentId("mcp-caller");

/** Extract text from MCP tool result content. */
function getText(result: unknown): string {
  const r = result as { content: readonly { type: string; text: string }[] };
  const first = r.content[0];
  if (first === undefined) throw new Error("No content in MCP result");
  return first.text;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tools/list", () => {
  test("returns agent tools when no platform config", async () => {
    const tools = [createMockTool("read_file", "Read a file")];
    const { client, server } = await createTestPair({
      agent: createMockAgent(tools),
      transport: null as never, // overridden by createTestPair
    });
    const result = await client.listTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe("read_file");
    await server.stop();
  });

  test("returns agent + platform tools when platform enabled", async () => {
    const tools = [createMockTool("read_file", "Read a file")];
    const { client, server } = await createTestPair({
      agent: createMockAgent(tools),
      transport: null as never,
      platform: {
        callerId: CALLER_ID,
        mailbox: createMockMailbox(),
        taskBoard: createMockTaskBoard(),
        registry: createMockRegistry(),
      },
    });
    const result = await client.listTools();
    // 1 agent tool + 7 platform tools
    expect(result.tools).toHaveLength(8);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("koi_send_message");
    expect(names).toContain("koi_list_messages");
    expect(names).toContain("koi_list_tasks");
    expect(names).toContain("koi_get_task");
    expect(names).toContain("koi_update_task");
    expect(names).toContain("koi_task_output");
    expect(names).toContain("koi_list_agents");
    await server.stop();
  });

  test("returns only mailbox tools when only mailbox enabled", async () => {
    const { client, server } = await createTestPair({
      agent: createMockAgent(),
      transport: null as never,
      platform: {
        callerId: CALLER_ID,
        mailbox: createMockMailbox(),
      },
    });
    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("koi_send_message");
    expect(names).toContain("koi_list_messages");
    await server.stop();
  });

  test("returns empty list when no capabilities", async () => {
    const { client, server } = await createTestPair({
      agent: createMockAgent(),
      transport: null as never,
    });
    const result = await client.listTools();
    expect(result.tools).toHaveLength(0);
    await server.stop();
  });
});

describe("tools/call — agent tools", () => {
  test("executes agent tool and returns result", async () => {
    const tools = [
      createMockTool("add", "Add numbers", async (args) => {
        return Number(args.a) + Number(args.b);
      }),
    ];
    const { client, server } = await createTestPair({
      agent: createMockAgent(tools),
      transport: null as never,
    });
    const result = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } });
    expect(getText(result)).toBe("5");
    await server.stop();
  });

  test("returns error for unknown tool", async () => {
    const { client, server } = await createTestPair({
      agent: createMockAgent(),
      transport: null as never,
    });
    const result = await client.callTool({ name: "nonexistent", arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(getText(result)).toBe("Unknown tool: nonexistent");
    await server.stop();
  });
});

describe("tools/call — platform tools", () => {
  test("koi_send_message sends with callerId as from", async () => {
    const mailbox = createMockMailbox();
    const { client, server } = await createTestPair({
      agent: createMockAgent(),
      transport: null as never,
      platform: { callerId: CALLER_ID, mailbox },
    });
    const result = await client.callTool({
      name: "koi_send_message",
      arguments: { to: "agent-target", type: "test", payload: { data: 1 } },
    });
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(mailbox.send).toHaveBeenCalledTimes(1);
    const call = (mailbox.send as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call.from).toBe(CALLER_ID);
    expect(call.kind).toBe("event");
    await server.stop();
  });

  test("koi_list_messages returns messages", async () => {
    const mailbox = createMockMailbox();
    // Send a message first
    await mailbox.send({
      from: CALLER_ID,
      to: agentId("other"),
      kind: "event",
      type: "test",
      payload: {},
    });
    const { client, server } = await createTestPair({
      agent: createMockAgent(),
      transport: null as never,
      platform: { callerId: CALLER_ID, mailbox },
    });
    const result = await client.callTool({ name: "koi_list_messages", arguments: {} });
    const parsed = JSON.parse(getText(result));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe("event");
    await server.stop();
  });

  test("koi_list_tasks returns lean projections", async () => {
    const tasks = [
      createMockTask("t-1", "pending"),
      createMockTask("t-2", "in_progress", "worker-1"),
    ];
    const { client, server } = await createTestPair({
      agent: createMockAgent(),
      transport: null as never,
      platform: { callerId: CALLER_ID, taskBoard: createMockTaskBoard(tasks) },
    });
    const result = await client.callTool({ name: "koi_list_tasks", arguments: {} });
    const parsed = JSON.parse(getText(result));
    expect(parsed).toHaveLength(2);
    // Lean projection — no description, version, retries
    expect(parsed[0].subject).toBeDefined();
    expect(parsed[0].version).toBeUndefined();
    await server.stop();
  });

  test("koi_list_tasks filters by status", async () => {
    const tasks = [
      createMockTask("t-1", "pending"),
      createMockTask("t-2", "in_progress", "worker-1"),
    ];
    const { client, server } = await createTestPair({
      agent: createMockAgent(),
      transport: null as never,
      platform: { callerId: CALLER_ID, taskBoard: createMockTaskBoard(tasks) },
    });
    const result = await client.callTool({
      name: "koi_list_tasks",
      arguments: { status: "pending" },
    });
    const parsed = JSON.parse(getText(result));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe("pending");
    await server.stop();
  });

  test("koi_get_task returns full details", async () => {
    const tasks = [createMockTask("t-1", "pending")];
    const { client, server } = await createTestPair({
      agent: createMockAgent(),
      transport: null as never,
      platform: { callerId: CALLER_ID, taskBoard: createMockTaskBoard(tasks) },
    });
    const result = await client.callTool({
      name: "koi_get_task",
      arguments: { taskId: "t-1" },
    });
    const parsed = JSON.parse(getText(result));
    expect(parsed.id).toBe("t-1");
    expect(parsed.description).toBeDefined();
    // metadata and activeForm excluded from MCP projection
    expect(parsed.metadata).toBeUndefined();
    expect(parsed.activeForm).toBeUndefined();
    await server.stop();
  });

  test("koi_get_task returns NOT_FOUND for missing task", async () => {
    const { client, server } = await createTestPair({
      agent: createMockAgent(),
      transport: null as never,
      platform: { callerId: CALLER_ID, taskBoard: createMockTaskBoard() },
    });
    const result = await client.callTool({
      name: "koi_get_task",
      arguments: { taskId: "nonexistent" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(getText(result)).toContain("Task not found");
    await server.stop();
  });

  test("koi_update_task start calls startTask", async () => {
    const board = createMockTaskBoard([createMockTask("t-1", "pending")]);
    const { client, server } = await createTestPair({
      agent: createMockAgent(),
      transport: null as never,
      platform: { callerId: CALLER_ID, taskBoard: board },
    });
    await client.callTool({
      name: "koi_update_task",
      arguments: { taskId: "t-1", action: "start" },
    });
    expect(board.startTask).toHaveBeenCalledTimes(1);
    await server.stop();
  });

  test("koi_update_task complete calls completeOwnedTask", async () => {
    const board = createMockTaskBoard([createMockTask("t-1", "in_progress", "mcp-caller")]);
    const { client, server } = await createTestPair({
      agent: createMockAgent(),
      transport: null as never,
      platform: { callerId: CALLER_ID, taskBoard: board },
    });
    await client.callTool({
      name: "koi_update_task",
      arguments: { taskId: "t-1", action: "complete", output: "done" },
    });
    expect(board.completeOwnedTask).toHaveBeenCalledTimes(1);
    await server.stop();
  });

  test("koi_list_agents passes visibility context", async () => {
    const registry = createMockRegistry([
      { agentId: agentId("a-1"), agentType: "worker" as const },
    ]);
    const { client, server } = await createTestPair({
      agent: createMockAgent(),
      transport: null as never,
      platform: { callerId: CALLER_ID, registry },
    });
    const result = await client.callTool({ name: "koi_list_agents", arguments: {} });
    // Verify visibility context was passed
    expect(registry.list).toHaveBeenCalledTimes(1);
    const [, visibility] = (registry.list as ReturnType<typeof mock>).mock.calls[0]!;
    expect(visibility).toEqual({ callerId: CALLER_ID });
    // Verify lean projection
    const parsed = JSON.parse(getText(result));
    expect(parsed[0].agentId).toBeDefined();
    expect(parsed[0].metadata).toBeUndefined();
    await server.stop();
  });
});

describe("server lifecycle", () => {
  test("toolCount reports correct count", async () => {
    const tools = [createMockTool("t1", "Tool 1"), createMockTool("t2", "Tool 2")];
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      agent: createMockAgent(tools),
      transport: serverTransport,
      platform: { callerId: CALLER_ID, mailbox: createMockMailbox() },
    });
    // 2 agent tools + 2 mailbox platform tools
    expect(server.toolCount()).toBe(4);
    await server.stop();
  });

  test("start and stop lifecycle", async () => {
    const [_clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      agent: createMockAgent(),
      transport: serverTransport,
    });
    await server.start();
    await server.stop();
    // Should not throw
  });
});

describe("error handling", () => {
  test("tool execution error returns sanitized message", async () => {
    const tools = [
      createMockTool("failing", "Always fails", async () => {
        throw new Error("Internal DB error at /var/data/koi\nstack trace here");
      }),
    ];
    const { client, server } = await createTestPair({
      agent: createMockAgent(tools),
      transport: null as never,
    });
    const result = await client.callTool({ name: "failing", arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = getText(result);
    // Stack trace should be stripped
    expect(text).not.toContain("stack trace");
    expect(text).toContain("failing");
    await server.stop();
  });
});
