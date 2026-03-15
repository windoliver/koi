import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { BatchWriteEntry } from "./batch-write.js";
import { batchWrite } from "./batch-write.js";
import type { NexusClient } from "./types.js";

function createMockWriteClient(failures: ReadonlySet<string> = new Set()): {
  readonly client: NexusClient;
  readonly written: Map<string, unknown>;
} {
  const written = new Map<string, unknown>();
  const client: NexusClient = {
    rpc: async <T>(
      _method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      const path = params.path as string;
      if (failures.has(path)) {
        return {
          ok: false,
          error: { code: "EXTERNAL", message: `write failed: ${path}`, retryable: true },
        };
      }
      written.set(path, params.data);
      return { ok: true, value: undefined as unknown as T };
    },
  };
  return { client, written };
}

describe("batchWrite", () => {
  test("writes all entries successfully", async () => {
    const { client, written } = createMockWriteClient();
    const entries: readonly BatchWriteEntry[] = [
      { path: "a.json", data: { id: "a" } },
      { path: "b.json", data: { id: "b" } },
    ];

    const result = await batchWrite(client, entries);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.succeeded).toBe(2);
      expect(result.value.failed).toBe(0);
    }
    expect(written.get("a.json")).toEqual({ id: "a" });
    expect(written.get("b.json")).toEqual({ id: "b" });
  });

  test("tallies individual write failures without aborting", async () => {
    const failures = new Set(["fail.json"]);
    const { client, written } = createMockWriteClient(failures);
    const entries: readonly BatchWriteEntry[] = [
      { path: "ok.json", data: "content" },
      { path: "fail.json", data: "content" },
      { path: "also-ok.json", data: "content" },
    ];

    const result = await batchWrite(client, entries);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.succeeded).toBe(2);
      expect(result.value.failed).toBe(1);
    }
    expect(written.has("ok.json")).toBe(true);
    expect(written.has("fail.json")).toBe(false);
    expect(written.has("also-ok.json")).toBe(true);
  });

  test("all entries fail", async () => {
    const failures = new Set(["a.json", "b.json"]);
    const { client } = createMockWriteClient(failures);
    const entries: readonly BatchWriteEntry[] = [
      { path: "a.json", data: 1 },
      { path: "b.json", data: 2 },
    ];

    const result = await batchWrite(client, entries);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.succeeded).toBe(0);
      expect(result.value.failed).toBe(2);
    }
  });

  test("returns zero counts for empty entries", async () => {
    const { client } = createMockWriteClient();

    const result = await batchWrite(client, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.succeeded).toBe(0);
      expect(result.value.failed).toBe(0);
    }
  });

  test("respects concurrency limit", async () => {
    // let justified: mutable counter for tracking in-flight requests
    let maxConcurrent = 0;
    let current = 0;

    const client: NexusClient = {
      rpc: async <T>(
        _method: string,
        _params: Record<string, unknown>,
      ): Promise<Result<T, KoiError>> => {
        current += 1;
        if (current > maxConcurrent) maxConcurrent = current;
        await Bun.sleep(10);
        current -= 1;
        return { ok: true, value: undefined as unknown as T };
      },
    };

    const entries: readonly BatchWriteEntry[] = Array.from({ length: 10 }, (_, i) => ({
      path: `file-${i}.json`,
      data: i,
    }));
    const result = await batchWrite(client, entries, { concurrency: 3 });

    expect(result.ok).toBe(true);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  test("clamps concurrency of 0 to 1 — no infinite loop", async () => {
    const { client } = createMockWriteClient();
    const entries: readonly BatchWriteEntry[] = [{ path: "a.json", data: "content" }];

    const result = await batchWrite(client, entries, { concurrency: 0 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.succeeded).toBe(1);
    }
  });

  test("clamps negative concurrency to 1", async () => {
    const { client } = createMockWriteClient();
    const entries: readonly BatchWriteEntry[] = [{ path: "a.json", data: "content" }];

    const result = await batchWrite(client, entries, { concurrency: -5 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.succeeded).toBe(1);
    }
  });

  test("passes correct method and params to rpc", async () => {
    const calls: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [];
    const client: NexusClient = {
      rpc: async <T>(
        method: string,
        params: Record<string, unknown>,
      ): Promise<Result<T, KoiError>> => {
        calls.push({ method, params });
        return { ok: true, value: undefined as unknown as T };
      },
    };

    await batchWrite(client, [{ path: "test.json", data: { key: "value" } }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("write");
    expect(calls[0]?.params).toEqual({ path: "test.json", data: { key: "value" } });
  });
});
