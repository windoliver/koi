/**
 * Platform tool unit tests — direct execution without MCP protocol.
 *
 * Tests security invariants: callerId enforcement, kind restriction,
 * ownership enforcement, visibility context, error sanitization.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentMessage,
  AgentRegistry,
  KoiError,
  MailboxComponent,
  ManagedTaskBoard,
  RegistryEntry,
  Result,
  Task,
  TaskBoard,
  TaskItemId,
} from "@koi/core";
import { agentId } from "@koi/core";
import { sanitizeMcpError } from "../errors.js";
import { createPlatformTools } from "../platform-tools.js";

// ---------------------------------------------------------------------------
// Mock helpers (minimal — just what platform tools need)
// ---------------------------------------------------------------------------

const CALLER = agentId("test-caller");

function mockMailbox(): MailboxComponent & { calls: readonly unknown[] } {
  const calls: unknown[] = [];
  return {
    get calls() {
      return calls;
    },
    send: mock(async (input: unknown) => {
      calls.push(input);
      return {
        ok: true,
        value: {
          ...(input as Record<string, unknown>),
          id: "msg-1",
          createdAt: "2026-01-01T00:00:00Z",
        },
      } as Result<AgentMessage, KoiError>;
    }),
    onMessage: () => () => {},
    list: mock(async () => []),
  };
}

function mockTaskBoard(tasks: readonly Task[] = []): ManagedTaskBoard {
  const taskMap = new Map<string, Task>();
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
    result: () => undefined,
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
    nextId: async () => "t-new" as TaskItemId,
    add: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    addAll: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    assign: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    unassign: async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>,
    startTask: mock(async () => ({ ok: true, value: board }) as Result<TaskBoard, KoiError>),
    hasResultPersistence: () => false,
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

function mockRegistry(): AgentRegistry {
  return {
    register: async () => ({}) as RegistryEntry,
    deregister: async () => true,
    lookup: async () => undefined,
    list: mock(
      async () =>
        [
          {
            agentId: agentId("a-1"),
            agentType: "worker",
            status: { phase: "running", generation: 42, conditions: [] },
            registeredAt: Date.now(),
            metadata: { secret: "should-not-appear" },
          },
        ] as unknown as readonly RegistryEntry[],
    ),
    transition: async () => ({ ok: true, value: {} }) as unknown as Result<RegistryEntry, KoiError>,
    patch: async () => ({ ok: true, value: {} }) as unknown as Result<RegistryEntry, KoiError>,
    watch: () => () => {},
    [Symbol.asyncDispose]: async () => {},
  } as unknown as AgentRegistry;
}

function makeTask(id: string, status: string): Task {
  return {
    id: id as TaskItemId,
    subject: `Task ${id}`,
    description: `Desc ${id}`,
    dependencies: [],
    status: status as Task["status"],
    retries: 0,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPlatformTools", () => {
  test("creates 7 tools when all capabilities provided", () => {
    const tools = createPlatformTools({
      callerId: CALLER,
      mailbox: mockMailbox(),
      taskBoard: mockTaskBoard(),
      registry: mockRegistry(),
    });
    expect(tools).toHaveLength(7);
  });

  test("creates 2 tools for mailbox only", () => {
    const tools = createPlatformTools({
      callerId: CALLER,
      mailbox: mockMailbox(),
    });
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.descriptor.name)).toEqual(["koi_send_message", "koi_list_messages"]);
  });

  test("creates 4 tools for taskBoard only", () => {
    const tools = createPlatformTools({
      callerId: CALLER,
      taskBoard: mockTaskBoard(),
    });
    expect(tools).toHaveLength(4);
  });

  test("creates 1 tool for registry only", () => {
    const tools = createPlatformTools({
      callerId: CALLER,
      registry: mockRegistry(),
    });
    expect(tools).toHaveLength(1);
  });
});

describe("koi_send_message security", () => {
  test("from is always callerId regardless of args", async () => {
    const mb = mockMailbox();
    const tools = createPlatformTools({ callerId: CALLER, mailbox: mb });
    const sendTool = tools.find((t) => t.descriptor.name === "koi_send_message")!;

    await sendTool.execute({
      to: "target",
      type: "test",
      payload: { x: 1 },
    });

    expect(mb.calls).toHaveLength(1);
    expect((mb.calls[0] as Record<string, unknown>).from).toBe(CALLER);
  });

  test("kind is always event", async () => {
    const mb = mockMailbox();
    const tools = createPlatformTools({ callerId: CALLER, mailbox: mb });
    const sendTool = tools.find((t) => t.descriptor.name === "koi_send_message")!;

    await sendTool.execute({
      to: "target",
      type: "test",
      payload: {},
    });

    expect(mb.calls).toHaveLength(1);
    expect((mb.calls[0] as Record<string, unknown>).kind).toBe("event");
  });
});

describe("koi_update_task ownership", () => {
  test("complete uses completeOwnedTask with callerId", async () => {
    const board = mockTaskBoard([makeTask("t-1", "in_progress")]);
    const tools = createPlatformTools({ callerId: CALLER, taskBoard: board });
    const updateTool = tools.find((t) => t.descriptor.name === "koi_update_task")!;

    await updateTool.execute({ taskId: "t-1", action: "complete", output: "done" });

    expect(board.completeOwnedTask).toHaveBeenCalledTimes(1);
    const [, callerArg] = (board.completeOwnedTask as ReturnType<typeof mock>).mock.calls[0]!;
    expect(callerArg).toBe(CALLER);
  });

  test("fail uses failOwnedTask with callerId", async () => {
    const board = mockTaskBoard([makeTask("t-1", "in_progress")]);
    const tools = createPlatformTools({ callerId: CALLER, taskBoard: board });
    const updateTool = tools.find((t) => t.descriptor.name === "koi_update_task")!;

    await updateTool.execute({ taskId: "t-1", action: "fail", error: "broke" });

    expect(board.failOwnedTask).toHaveBeenCalledTimes(1);
    const [, callerArg] = (board.failOwnedTask as ReturnType<typeof mock>).mock.calls[0]!;
    expect(callerArg).toBe(CALLER);
  });
});

describe("koi_list_agents visibility", () => {
  test("passes VisibilityContext with callerId", async () => {
    const reg = mockRegistry();
    const tools = createPlatformTools({ callerId: CALLER, registry: reg });
    const listTool = tools.find((t) => t.descriptor.name === "koi_list_agents")!;

    await listTool.execute({});

    const [, visibility] = (reg.list as ReturnType<typeof mock>).mock.calls[0]!;
    expect(visibility).toEqual({ callerId: CALLER });
  });

  test("excludes metadata and generation from response", async () => {
    const reg = mockRegistry();
    const tools = createPlatformTools({ callerId: CALLER, registry: reg });
    const listTool = tools.find((t) => t.descriptor.name === "koi_list_agents")!;

    const result = (await listTool.execute({})) as readonly Record<string, unknown>[];

    expect(result[0]?.metadata).toBeUndefined();
    expect(result[0]?.generation).toBeUndefined();
    expect(result[0]?.agentId).toBeDefined();
    expect(result[0]?.phase).toBe("running");
  });
});

describe("sanitizeMcpError", () => {
  test("strips stack traces", () => {
    const err = new Error("DB failed\n    at Connection.query (pool.ts:42)\n    at foo");
    const result = sanitizeMcpError("my_tool", err);
    expect(result).toBe('Tool "my_tool" failed: DB failed');
    expect(result).not.toContain("pool.ts");
  });

  test("handles non-Error values", () => {
    const result = sanitizeMcpError("my_tool", "raw string");
    expect(result).toBe('Tool "my_tool" failed: unexpected error');
  });

  test("truncates long messages", () => {
    const err = new Error("x".repeat(500));
    const result = sanitizeMcpError("my_tool", err);
    expect(result.length).toBeLessThan(250);
  });
});
