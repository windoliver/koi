import { describe, expect, test } from "bun:test";
import type { ScheduledTask } from "@koi/core";
import { createNexusTaskQueue } from "./nexus-queue.js";

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

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
    id: taskId("task-123"),
    agentId: agentId("agent-a"),
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

function createMockFetch(
  status: number,
  body: unknown,
  requestCapture?: { readonly calls: Array<CapturedCall> },
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requestCapture?.calls.push({ url, init: init ?? {} });
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

function createRpcFetch(
  handler: (method: string, params: Record<string, unknown>) => unknown,
  requestCapture?: { readonly calls: Array<CapturedCall> },
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requestCapture?.calls.push({ url, init: init ?? {} });
    if (url.includes("/api/nfs/")) {
      const method = decodeURIComponent(url.split("/api/nfs/")[1] ?? "");
      const body = JSON.parse(String(init?.body ?? "{}")) as { params?: Record<string, unknown> };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: handler(method, body.params ?? {}),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ id: "task-123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

function createInvalidJsonFetch(): typeof globalThis.fetch {
  return (async () =>
    new Response("not json{{{", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

const BASE_CONFIG = {
  baseUrl: "https://scheduler.nexus.example.com",
  apiKey: "sk-test-123",
  timeoutMs: 5_000,
} as const;

describe("createNexusTaskQueue", () => {
  test("enqueue sends correct HTTP request", async () => {
    const capture = { calls: [] as Array<CapturedCall> };
    const queue = createNexusTaskQueue({
      ...BASE_CONFIG,
      fetch: createMockFetch(200, { id: "task-123" }, capture),
    });

    await queue.enqueue(makeTask({ timeoutMs: 30_000, scheduledAt: 2_000 }), "idem-1");

    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]?.url).toBe(
      "https://scheduler.nexus.example.com/api/v2/scheduler/submit",
    );
    const body = JSON.parse(String(capture.calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.agent_id).toBe("agent-a");
    expect(body.timeout_ms).toBe(30_000);
    expect(body.scheduled_at).toBe(2_000);
    expect(body.idempotency_key).toBe("idem-1");
  });

  test("status returns undefined on 404", async () => {
    const queue = createNexusTaskQueue({
      ...BASE_CONFIG,
      fetch: createMockFetch(404, { message: "not found" }),
    });

    expect(await queue.status(taskId("missing"))).toBeUndefined();
  });

  test("tick grants only one winner for a schedule slot", async () => {
    const seen = new Set<string>();
    const queue = createNexusTaskQueue({
      ...BASE_CONFIG,
      visibilityTimeoutMs: 30_000,
      fetch: createRpcFetch((method, params) => {
        if (method === "scheduler.tick") {
          const key = `${String(params.schedule_id)}:current`;
          if (seen.has(key)) return { claimed: false };
          seen.add(key);
          return { claimed: true };
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      }),
    });

    const first = await queue.tick?.(scheduleId("schedule-1") as never, "node-a");
    const second = await queue.tick?.(scheduleId("schedule-1") as never, "node-b");

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  test("distributed RPC omits Authorization header when apiKey is not provided", async () => {
    const capture = { calls: [] as Array<CapturedCall> };
    const queue = createNexusTaskQueue({
      baseUrl: BASE_CONFIG.baseUrl,
      timeoutMs: BASE_CONFIG.timeoutMs,
      visibilityTimeoutMs: 30_000,
      fetch: createRpcFetch((method) => {
        if (method === "scheduler.tick") {
          return { claimed: true };
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      }, capture),
    });

    await queue.tick?.(scheduleId("schedule-1") as never, "node-a");

    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]?.init.headers).toEqual({
      "Content-Type": "application/json",
    });
  });

  test("throws on invalid JSON response", async () => {
    const queue = createNexusTaskQueue({
      ...BASE_CONFIG,
      fetch: createInvalidJsonFetch(),
    });

    await expect(queue.enqueue(makeTask())).rejects.toThrow("Failed to parse");
  });
});
