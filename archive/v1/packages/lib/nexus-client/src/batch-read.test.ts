import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { batchRead } from "./batch-read.js";
import type { NexusClient } from "./types.js";

function createMockClient(responses: ReadonlyMap<string, Result<string, KoiError>>): NexusClient {
  return {
    rpc: async <T>(
      _method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      const path = params.path as string;
      const response = responses.get(path);
      if (response === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Not found: ${path}`, retryable: false },
        };
      }
      return response as Result<T, KoiError>;
    },
  };
}

describe("batchRead", () => {
  test("reads all paths successfully", async () => {
    const responses = new Map<string, Result<string, KoiError>>([
      ["a.json", { ok: true, value: '{"id":"a"}' }],
      ["b.json", { ok: true, value: '{"id":"b"}' }],
    ]);
    const client = createMockClient(responses);

    const result = await batchRead(client, ["a.json", "b.json"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.size).toBe(2);
      expect(result.value.get("a.json")).toBe('{"id":"a"}');
      expect(result.value.get("b.json")).toBe('{"id":"b"}');
    }
  });

  test("skips NOT_FOUND paths", async () => {
    const responses = new Map<string, Result<string, KoiError>>([
      ["a.json", { ok: true, value: "content" }],
    ]);
    const client = createMockClient(responses);

    const result = await batchRead(client, ["a.json", "missing.json"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.size).toBe(1);
      expect(result.value.has("missing.json")).toBe(false);
    }
  });

  test("skips EXTERNAL errors", async () => {
    const responses = new Map<string, Result<string, KoiError>>([
      ["a.json", { ok: true, value: "content" }],
      [
        "fail.json",
        {
          ok: false,
          error: { code: "EXTERNAL", message: "server error", retryable: true },
        },
      ],
    ]);
    const client = createMockClient(responses);

    const result = await batchRead(client, ["a.json", "fail.json"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.size).toBe(1);
    }
  });

  test("propagates non-skip errors", async () => {
    const responses = new Map<string, Result<string, KoiError>>([
      [
        "bad.json",
        {
          ok: false,
          error: { code: "PERMISSION", message: "denied", retryable: false },
        },
      ],
    ]);
    const client = createMockClient(responses);

    const result = await batchRead(client, ["bad.json"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("respects concurrency limit", async () => {
    // Track concurrent calls
    // let justified: mutable counter for tracking in-flight requests
    let maxConcurrent = 0;
    let current = 0;

    const client: NexusClient = {
      rpc: async <T>(
        _method: string,
        params: Record<string, unknown>,
      ): Promise<Result<T, KoiError>> => {
        current += 1;
        if (current > maxConcurrent) maxConcurrent = current;
        await Bun.sleep(10);
        current -= 1;
        const path = params.path as string;
        return { ok: true, value: path as unknown as T };
      },
    };

    const paths = Array.from({ length: 10 }, (_, i) => `file-${i}.json`);
    const result = await batchRead(client, paths, { concurrency: 3 });

    expect(result.ok).toBe(true);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  test("returns empty map for empty paths", async () => {
    const client = createMockClient(new Map());

    const result = await batchRead(client, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.size).toBe(0);
    }
  });

  test("clamps concurrency of 0 to 1 — no infinite loop", async () => {
    const responses = new Map<string, Result<string, KoiError>>([
      ["a.json", { ok: true, value: "content" }],
    ]);
    const client = createMockClient(responses);

    const result = await batchRead(client, ["a.json"], { concurrency: 0 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.size).toBe(1);
    }
  });

  test("clamps negative concurrency to 1", async () => {
    const responses = new Map<string, Result<string, KoiError>>([
      ["a.json", { ok: true, value: "content" }],
    ]);
    const client = createMockClient(responses);

    const result = await batchRead(client, ["a.json"], { concurrency: -5 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.size).toBe(1);
    }
  });
});
