import { describe, expect, test } from "bun:test";
import type { ScheduledTask } from "@koi/core";
import { agentId, taskId } from "@koi/core";
import { createNexusTaskQueue } from "./nexus-queue.js";

// ---------------------------------------------------------------------------
// Mock fetch factories
// ---------------------------------------------------------------------------

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function createMockFetch(
  status: number,
  body: unknown,
  requestCapture?: { readonly calls: Array<CapturedCall> },
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (requestCapture !== undefined) {
      (requestCapture.calls as Array<CapturedCall>).push({
        url,
        init: init ?? {},
      });
    }
    return new Response(body !== undefined ? JSON.stringify(body) : "", {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

function createNetworkErrorFetch(): typeof globalThis.fetch {
  return (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;
}

function createInvalidJsonFetch(): typeof globalThis.fetch {
  return (async () => {
    return new Response("not json{{{", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

const BASE_CONFIG = {
  baseUrl: "https://scheduler.nexus.example.com",
  apiKey: "sk-test-123",
  timeoutMs: 5_000,
} as const;

const SAMPLE_TASK: ScheduledTask = {
  id: taskId("task_123"),
  agentId: agentId("agent_a"),
  input: { kind: "text", text: "hello" },
  mode: "spawn",
  priority: 5,
  status: "pending",
  createdAt: 1000,
  retries: 0,
  maxRetries: 3,
};

/** Safe accessor — fails with a clear message instead of non-null assertion. */
function firstCall(capture: { readonly calls: readonly CapturedCall[] }): CapturedCall {
  const call = capture.calls[0];
  if (call === undefined) throw new Error("Expected at least one captured call");
  return call;
}

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------

describe("createNexusTaskQueue", () => {
  describe("enqueue", () => {
    test("sends correct HTTP request", async () => {
      const capture = { calls: [] as Array<CapturedCall> };
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { id: "task_123" }, capture),
      });

      await queue.enqueue(SAMPLE_TASK);

      expect(capture.calls.length).toBe(1);
      const call = firstCall(capture);
      expect(call.url).toBe("https://scheduler.nexus.example.com/api/v2/scheduler/submit");
      expect(call.init.method).toBe("POST");

      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-test-123");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    test("sends correct body shape with snake_case fields", async () => {
      const capture = { calls: [] as Array<CapturedCall> };
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { id: "task_123" }, capture),
      });

      await queue.enqueue(SAMPLE_TASK);

      const body = JSON.parse(firstCall(capture).init.body as string) as Record<string, unknown>;
      expect(body.task_id).toBe("task_123");
      expect(body.agent_id).toBe("agent_a");
      expect(body.priority).toBe(5);
      expect(body.mode).toBe("spawn");
    });

    test("passes idempotency_key in body", async () => {
      const capture = { calls: [] as Array<CapturedCall> };
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { id: "task_123" }, capture),
      });

      await queue.enqueue(SAMPLE_TASK, "sched_1:1000");

      const body = JSON.parse(firstCall(capture).init.body as string) as Record<string, unknown>;
      expect(body.idempotency_key).toBe("sched_1:1000");
    });

    test("omits idempotency_key when not provided", async () => {
      const capture = { calls: [] as Array<CapturedCall> };
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { id: "task_123" }, capture),
      });

      await queue.enqueue(SAMPLE_TASK);

      const body = JSON.parse(firstCall(capture).init.body as string) as Record<string, unknown>;
      expect("idempotency_key" in body).toBe(false);
    });

    test("returns TaskId from response", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { id: "nexus_task_456" }),
      });

      const id = await queue.enqueue(SAMPLE_TASK);
      expect(id).toBe(taskId("nexus_task_456"));
    });
  });

  // -------------------------------------------------------------------------
  // cancel
  // -------------------------------------------------------------------------

  describe("cancel", () => {
    test("sends POST to correct path", async () => {
      const capture = { calls: [] as Array<CapturedCall> };
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { cancelled: true }, capture),
      });

      await queue.cancel(taskId("task_789"));

      expect(firstCall(capture).url).toBe(
        "https://scheduler.nexus.example.com/api/v2/scheduler/task/task_789/cancel",
      );
      expect(firstCall(capture).init.method).toBe("POST");
    });

    test("returns true when cancelled", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { cancelled: true }),
      });

      const result = await queue.cancel(taskId("task_789"));
      expect(result).toBe(true);
    });

    test("returns false when not found in queue", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { cancelled: false }),
      });

      const result = await queue.cancel(taskId("task_789"));
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  describe("status", () => {
    test("sends GET to correct path", async () => {
      const capture = { calls: [] as Array<CapturedCall> };
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { status: "pending" }, capture),
      });

      await queue.status(taskId("task_789"));

      expect(firstCall(capture).url).toBe(
        "https://scheduler.nexus.example.com/api/v2/scheduler/task/task_789",
      );
      expect(firstCall(capture).init.method).toBe("GET");
    });

    test("returns mapped TaskStatus", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { status: "running" }),
      });

      const result = await queue.status(taskId("task_789"));
      expect(result).toBe("running");
    });

    test("returns undefined on 404", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(404, { message: "not found" }),
      });

      const result = await queue.status(taskId("task_789"));
      expect(result).toBeUndefined();
    });

    test("throws on non-404 errors (e.g., 500)", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(500, { message: "server error" }),
      });

      expect(queue.status(taskId("task_789"))).rejects.toThrow();
    });

    test("throws on unknown status value", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { status: "unknown_status" }),
      });

      expect(queue.status(taskId("task_789"))).rejects.toThrow("unknown task status");
    });
  });

  // -------------------------------------------------------------------------
  // Error mapping
  // -------------------------------------------------------------------------

  describe("error mapping", () => {
    test("401 throws with PERMISSION cause", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(401, { message: "Unauthorized" }),
      });

      try {
        await queue.enqueue(SAMPLE_TASK);
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(Error);
        const cause = (e as Error).cause as { readonly code: string };
        expect(cause.code).toBe("PERMISSION");
      }
    });

    test("403 throws with PERMISSION cause", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(403, { message: "Forbidden" }),
      });

      try {
        await queue.enqueue(SAMPLE_TASK);
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        const cause = (e as Error).cause as { readonly code: string };
        expect(cause.code).toBe("PERMISSION");
      }
    });

    test("429 throws with RATE_LIMIT cause", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(429, { message: "Too many requests" }),
      });

      try {
        await queue.enqueue(SAMPLE_TASK);
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        const cause = (e as Error).cause as { readonly code: string };
        expect(cause.code).toBe("RATE_LIMIT");
      }
    });

    test("500 throws with EXTERNAL cause (retryable)", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(500, { message: "Internal server error" }),
      });

      try {
        await queue.enqueue(SAMPLE_TASK);
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        const cause = (e as Error).cause as { readonly code: string; readonly retryable: boolean };
        expect(cause.code).toBe("EXTERNAL");
        expect(cause.retryable).toBe(true);
      }
    });

    test("network error throws with cause chain", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createNetworkErrorFetch(),
      });

      try {
        await queue.enqueue(SAMPLE_TASK);
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).toContain("Nexus scheduler request failed");
      }
    });

    test("invalid JSON response throws with meaningful error", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createInvalidJsonFetch(),
      });

      try {
        await queue.enqueue(SAMPLE_TASK);
        expect.unreachable("Should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).toContain("Failed to parse");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Auth header
  // -------------------------------------------------------------------------

  describe("auth", () => {
    test("includes Bearer token in Authorization header", async () => {
      const capture = { calls: [] as Array<CapturedCall> };
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        apiKey: "my-secret-key",
        fetch: createMockFetch(200, { id: "task_123" }, capture),
      });

      await queue.enqueue(SAMPLE_TASK);

      const headers = firstCall(capture).init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer my-secret-key");
    });
  });

  // -------------------------------------------------------------------------
  // AsyncDisposable
  // -------------------------------------------------------------------------

  describe("dispose", () => {
    test("asyncDispose is a no-op", async () => {
      const queue = createNexusTaskQueue({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { id: "task_123" }),
      });

      // Should not throw
      await queue[Symbol.asyncDispose]();
    });
  });
});
