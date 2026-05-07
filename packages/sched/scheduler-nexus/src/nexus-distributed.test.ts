import { describe, expect, test } from "bun:test";
import type { ScheduledTask } from "@koi/core";
import { createNexusSchedulerBackends } from "./nexus-scheduler.js";

function agentId(id: string): ScheduledTask["agentId"] {
  return id as ScheduledTask["agentId"];
}

function taskId(id: string): ScheduledTask["id"] {
  return id as ScheduledTask["id"];
}

function scheduleId(id: string): string {
  return id;
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

function createDistributedFetch(): typeof globalThis.fetch {
  const tasks = new Map<string, ScheduledTask>();
  const claims = new Map<string, { nodeId: string; claimedAt: number }>();
  const ticks = new Set<string>();

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/nfs/")) {
      const method = decodeURIComponent(url.split("/api/nfs/")[1] ?? "");
      const body = JSON.parse(String(init?.body ?? "{}")) as { params?: Record<string, unknown> };
      const params = body.params ?? {};

      const response = (() => {
        switch (method) {
          case "scheduler.task.save": {
            const task = {
              id: taskId(String(params.id)),
              agentId: agentId(String(params.agent_id)),
              input: params.input as ScheduledTask["input"],
              mode: params.mode as ScheduledTask["mode"],
              priority: Number(params.priority),
              status: params.status as ScheduledTask["status"],
              createdAt: Number(params.created_at),
              scheduledAt:
                params.scheduled_at === undefined ? undefined : Number(params.scheduled_at),
              retries: Number(params.retries),
              maxRetries: Number(params.max_retries),
            } satisfies ScheduledTask;
            tasks.set(String(params.id), task);
            return null;
          }
          case "scheduler.claim": {
            const now = Date.now();
            const limit = Number(params.limit ?? 1);
            const visibilityTimeoutMs = Number(params.visibility_timeout_ms ?? 30_000);
            const available = [...tasks.values()].filter((task) => {
              const claim = claims.get(task.id);
              return (
                task.status === "pending" &&
                (claim === undefined || now - claim.claimedAt >= visibilityTimeoutMs)
              );
            });
            const claimed = available.slice(0, limit);
            for (const task of claimed) {
              claims.set(task.id, { nodeId: String(params.node_id), claimedAt: now });
            }
            return {
              tasks: claimed.map((task) => ({
                id: task.id,
                agent_id: task.agentId,
                input: task.input,
                mode: task.mode,
                priority: task.priority,
                status: task.status,
                created_at: task.createdAt,
                retries: task.retries,
                max_retries: task.maxRetries,
              })),
            };
          }
          case "scheduler.ack": {
            claims.delete(String(params.task_id));
            tasks.delete(String(params.task_id));
            return { ok: true };
          }
          case "scheduler.nack": {
            claims.delete(String(params.task_id));
            return { ok: true };
          }
          case "scheduler.tick": {
            const key = `${String(params.schedule_id)}:${Math.floor(Date.now() / 60_000)}`;
            if (ticks.has(key)) return { claimed: false };
            ticks.add(key);
            return { claimed: true };
          }
          case "scheduler.schedule.list":
            return { schedules: [] };
          case "scheduler.task.query":
            return { tasks: [] };
          default:
            throw new Error(`Unexpected RPC method: ${method}`);
        }
      })();

      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: response }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith("/api/v2/scheduler/submit")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      tasks.set(String(body.task_id), makeTask({ id: taskId(String(body.task_id)) }));
      return new Response(JSON.stringify({ id: body.task_id }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ cancelled: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

describe("createNexusSchedulerBackends", () => {
  test("returns scheduler-compatible backends", () => {
    const backends = createNexusSchedulerBackends({
      baseUrl: "http://nexus.test",
      apiKey: "test-key",
      visibilityTimeoutMs: 30_000,
      fetch: createDistributedFetch(),
    });

    expect(typeof backends.taskStore.save).toBe("function");
    expect(typeof backends.scheduleStore.saveSchedule).toBe("function");
    expect(typeof backends.queueBackend.enqueue).toBe("function");
    expect(typeof backends.queueBackend.claim).toBe("function");
    expect(typeof backends.queueBackend.tick).toBe("function");
  });

  test("claim/ack/tick distributed flow behaves consistently", async () => {
    const fetch = createDistributedFetch();
    const backends = createNexusSchedulerBackends({
      baseUrl: "http://nexus.test",
      apiKey: "test-key",
      visibilityTimeoutMs: 30_000,
      fetch,
    });

    await backends.taskStore.save(makeTask({ id: taskId("t1"), priority: 1 }));
    await backends.taskStore.save(makeTask({ id: taskId("t2"), priority: 2 }));

    const firstClaim = await backends.queueBackend.claim?.("node-a", 1);
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim?.[0]?.id).toBe(taskId("t1"));

    const secondClaim = await backends.queueBackend.claim?.("node-b", 5);
    expect(secondClaim).toHaveLength(1);
    expect(secondClaim?.[0]?.id).toBe(taskId("t2"));

    await expect(backends.queueBackend.ack?.(taskId("t1"))).resolves.toBe(true);
    await expect(backends.queueBackend.nack?.(taskId("t2"), "retry")).resolves.toBe(true);
    await expect(
      backends.queueBackend.tick?.(scheduleId("sched-1") as never, "node-a"),
    ).resolves.toBe(true);
    await expect(
      backends.queueBackend.tick?.(scheduleId("sched-1") as never, "node-b"),
    ).resolves.toBe(false);
  });
});
