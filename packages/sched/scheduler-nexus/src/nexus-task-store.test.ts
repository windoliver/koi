import { describe, expect, test } from "bun:test";
import type { Result, ScheduledTask } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createNexusTaskStore } from "./nexus-task-store.js";

function agentId(id: string): ScheduledTask["agentId"] {
  return id as ScheduledTask["agentId"];
}

function taskId(id: string): ScheduledTask["id"] {
  return id as ScheduledTask["id"];
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: taskId("task-1"),
    agentId: agentId("agent-1"),
    input: { kind: "text", text: "hello" },
    mode: "spawn",
    priority: 5,
    status: "pending",
    createdAt: 1_000,
    retries: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

describe("createNexusTaskStore", () => {
  test("save sends snake_case payload", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const store = createNexusTaskStore({
      call: async <T>(method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return ok(undefined as T);
      },
      close: () => {},
    } satisfies NexusTransport);

    await store.save(makeTask({ timeoutMs: 10_000 }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("scheduler.task.save");
    expect(calls[0]?.params.agent_id).toBe("agent-1");
    expect(calls[0]?.params.max_retries).toBe(3);
    expect(calls[0]?.params.timeout_ms).toBe(10_000);
  });

  test("load maps wire task to ScheduledTask", async () => {
    const store = createNexusTaskStore({
      call: async <T>() =>
        ok({
          task: {
            id: "task-2",
            agent_id: "agent-2",
            input: { kind: "text", text: "loaded" },
            mode: "dispatch",
            priority: 1,
            status: "running",
            created_at: 2_000,
            scheduled_at: 3_000,
            retries: 1,
            max_retries: 4,
          },
        } as T),
      close: () => {},
    } satisfies NexusTransport);

    const task = await store.load(taskId("task-2"));
    expect(task?.id).toBe(taskId("task-2"));
    expect(task?.agentId).toBe(agentId("agent-2"));
    expect(task?.scheduledAt).toBe(3_000);
    expect(task?.status).toBe("running");
  });

  test("query passes snake_case filters", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const store = createNexusTaskStore({
      call: async <T>(method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return ok({ tasks: [] } as T);
      },
      close: () => {},
    } satisfies NexusTransport);

    await store.query({
      agentId: agentId("agent-q"),
      status: "pending",
      priority: 2,
      limit: 3,
    });

    expect(calls[0]?.method).toBe("scheduler.task.query");
    expect(calls[0]?.params).toEqual({
      agent_id: "agent-q",
      status: "pending",
      priority: 2,
      limit: 3,
    });
  });
});
