import { describe, expect, test } from "bun:test";
import type { SpawnRequest, SpawnFn as UnifiedSpawnFn } from "@koi/core";
import { mapSpawnToTask } from "./spawn-adapter.js";
import type { TaskSpawnRequest } from "./types.js";

describe("mapSpawnToTask", () => {
  test("maps successful spawn result", async () => {
    const unified: UnifiedSpawnFn = async (_req: SpawnRequest) => ({
      ok: true as const,
      output: "completed",
    });

    const taskSpawn = mapSpawnToTask(unified);
    const request: TaskSpawnRequest = {
      description: "run analysis",
      agentName: "analyst",
      manifest: { name: "analyst", version: "0.1.0", model: { name: "test-model" } },
      signal: AbortSignal.timeout(5000),
    };

    const result = await taskSpawn(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe("completed");
    }
  });

  test("maps failed spawn result (KoiError → string)", async () => {
    const unified: UnifiedSpawnFn = async (_req: SpawnRequest) => ({
      ok: false as const,
      error: {
        code: "TIMEOUT",
        message: "spawn timed out",
        retryable: true,
      },
    });

    const taskSpawn = mapSpawnToTask(unified);
    const request: TaskSpawnRequest = {
      description: "run analysis",
      agentName: "analyst",
      manifest: { name: "analyst", version: "0.1.0", model: { name: "test-model" } },
      signal: AbortSignal.timeout(5000),
    };

    const result = await taskSpawn(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("spawn timed out");
    }
  });
});
