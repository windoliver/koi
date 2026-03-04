import { describe, expect, test } from "bun:test";
import type { SpawnFn, SpawnRequest, TaskResult } from "@koi/core";
import { agentId, taskItemId } from "@koi/core";
import { formatUpstreamContext, mapSpawnToWorker } from "./spawn-adapter.js";
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

  test("prepends upstream context to description when upstreamResults present", async () => {
    let captured: SpawnRequest | undefined;
    const unified: SpawnFn = async (req: SpawnRequest) => {
      captured = req;
      return { ok: true as const, output: "ok" };
    };

    const worker = mapSpawnToWorker(unified, "worker-agent");
    const upstream: TaskResult[] = [
      { taskId: taskItemId("task-1"), output: "result-1", durationMs: 50 },
    ];

    await worker({
      taskId: taskItemId("task-2"),
      description: "do the next thing",
      signal: AbortSignal.timeout(5000),
      upstreamResults: upstream,
    });

    expect(captured?.description).toContain("Upstream Context");
    expect(captured?.description).toContain("result-1");
    expect(captured?.description).toContain("do the next thing");
  });

  test("does not modify description when no upstream results", async () => {
    let captured: SpawnRequest | undefined;
    const unified: SpawnFn = async (req: SpawnRequest) => {
      captured = req;
      return { ok: true as const, output: "ok" };
    };

    const worker = mapSpawnToWorker(unified, "worker-agent");
    await worker({
      taskId: taskItemId("task-1"),
      description: "original description",
      signal: AbortSignal.timeout(5000),
    });

    expect(captured?.description).toBe("original description");
  });
});

describe("formatUpstreamContext", () => {
  test("formats upstream context into structured block", () => {
    const results: TaskResult[] = [
      {
        taskId: taskItemId("task-a"),
        output: "analysis complete",
        durationMs: 100,
        artifacts: [{ id: "art-1", kind: "file", uri: "file:///report.json" }],
        warnings: ["low confidence"],
      },
    ];

    const formatted = formatUpstreamContext(results, 2000);
    expect(formatted).toContain("Upstream: task-a");
    expect(formatted).toContain("Output: analysis complete");
    expect(formatted).toContain("Artifacts: file:file:///report.json");
    expect(formatted).toContain("Warnings: low confidence");
  });

  test("truncates output to maxCharsPerResult", () => {
    const longOutput = "x".repeat(500);
    const results: TaskResult[] = [
      { taskId: taskItemId("task-a"), output: longOutput, durationMs: 100 },
    ];

    const formatted = formatUpstreamContext(results, 50);
    expect(formatted).toContain("truncated");
    expect(formatted).not.toContain("x".repeat(500));
  });

  test("returns empty string for empty results array", () => {
    expect(formatUpstreamContext([], 2000)).toBe("");
  });
});
