import { describe, expect, test } from "bun:test";
import type { SpawnFn, SpawnRequest } from "@koi/core";
import { mapSpawnToMinion } from "./spawn-adapter.js";
import type { MinionSpawnRequest } from "./types.js";

describe("mapSpawnToMinion", () => {
  test("maps successful spawn result", async () => {
    const unified: SpawnFn = async (_req: SpawnRequest) => ({
      ok: true as const,
      output: "done",
    });

    const minion = mapSpawnToMinion(unified);
    const request: MinionSpawnRequest = {
      description: "test task",
      agentName: "worker",
      manifest: { name: "worker", version: "0.1.0", model: { name: "test-model" } },
      signal: AbortSignal.timeout(5000),
      taskIndex: 0,
    };

    const result = await minion(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe("done");
    }
  });

  test("maps failed spawn result (KoiError → string)", async () => {
    const unified: SpawnFn = async (_req: SpawnRequest) => ({
      ok: false as const,
      error: {
        code: "INTERNAL",
        message: "agent crashed",
        retryable: false,
      },
    });

    const minion = mapSpawnToMinion(unified);
    const request: MinionSpawnRequest = {
      description: "test task",
      agentName: "worker",
      manifest: { name: "worker", version: "0.1.0", model: { name: "test-model" } },
      signal: AbortSignal.timeout(5000),
      taskIndex: 1,
    };

    const result = await minion(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("agent crashed");
    }
  });

  test("passes taskIndex through to unified SpawnRequest", async () => {
    let captured: SpawnRequest | undefined;
    const unified: SpawnFn = async (req: SpawnRequest) => {
      captured = req;
      return { ok: true as const, output: "ok" };
    };

    const minion = mapSpawnToMinion(unified);
    await minion({
      description: "task",
      agentName: "worker",
      manifest: { name: "worker", version: "0.1.0", model: { name: "test-model" } },
      signal: AbortSignal.timeout(5000),
      taskIndex: 42,
    });

    expect(captured?.taskIndex).toBe(42);
  });
});
