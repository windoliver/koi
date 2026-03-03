import { describe, expect, test } from "bun:test";
import type { SpawnFn, SpawnRequest } from "@koi/core";
import { agentId, taskItemId } from "@koi/core";
import { mapSpawnToWorker } from "./spawn-adapter.js";
import type { SpawnWorkerRequest } from "./types.js";

describe("mapSpawnToWorker", () => {
  test("maps successful spawn result", async () => {
    const unified: SpawnFn = async (_req: SpawnRequest) => ({
      ok: true as const,
      output: "task done",
    });

    const worker = mapSpawnToWorker(unified, "worker-agent");
    const request: SpawnWorkerRequest = {
      taskId: taskItemId("task-1"),
      description: "do the thing",
      signal: AbortSignal.timeout(5000),
    };

    const result = await worker(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe("task done");
    }
  });

  test("maps failed spawn result (KoiError passed through)", async () => {
    const unified: SpawnFn = async (_req: SpawnRequest) => ({
      ok: false as const,
      error: {
        code: "INTERNAL",
        message: "adapter error",
        retryable: false,
      },
    });

    const worker = mapSpawnToWorker(unified, "worker-agent");
    const request: SpawnWorkerRequest = {
      taskId: taskItemId("task-2"),
      description: "another thing",
      signal: AbortSignal.timeout(5000),
    };

    const result = await worker(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toBe("adapter error");
    }
  });

  test("passes taskId and agentId through to unified SpawnRequest", async () => {
    let captured: SpawnRequest | undefined;
    const unified: SpawnFn = async (req: SpawnRequest) => {
      captured = req;
      return { ok: true as const, output: "ok" };
    };

    const worker = mapSpawnToWorker(unified, "my-worker");
    await worker({
      taskId: taskItemId("task-3"),
      description: "work",
      agentId: "copilot-123",
      signal: AbortSignal.timeout(5000),
    });

    expect(captured?.taskId).toBe(taskItemId("task-3"));
    expect(captured?.agentId).toBe(agentId("copilot-123"));
    expect(captured?.agentName).toBe("my-worker");
  });
});
