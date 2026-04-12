import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@koi/core";
import { createInFlightCache } from "./in-flight-cache.js";

function makeRequest(text: string, model = "claude-sonnet-4-6"): ModelRequest {
  return {
    messages: [{ senderId: "user", content: [{ kind: "text", text }], timestamp: 0 }],
    model,
  };
}

describe("createInFlightCache", () => {
  test("executes fn once for a single request", async () => {
    const cache = createInFlightCache<string>();
    let calls = 0;
    const result = await cache.getOrExecute(makeRequest("hello"), async () => {
      calls++;
      return "response";
    });
    expect(result).toBe("response");
    expect(calls).toBe(1);
  });

  test("deduplicates identical concurrent requests — fn called once", async () => {
    const cache = createInFlightCache<string>();
    let calls = 0;

    const execute = (): Promise<string> => {
      calls++;
      return new Promise((resolve) => setTimeout(() => resolve("shared"), 10));
    };

    const req = makeRequest("concurrent");
    const [r1, r2] = await Promise.all([
      cache.getOrExecute(req, execute),
      cache.getOrExecute(req, execute),
    ]);

    expect(r1).toBe("shared");
    expect(r2).toBe("shared");
    expect(calls).toBe(1);
  });

  test("different requests are not deduplicated", async () => {
    const cache = createInFlightCache<string>();
    let calls = 0;

    const result1 = await cache.getOrExecute(makeRequest("hello"), async () => {
      calls++;
      return "a";
    });
    const result2 = await cache.getOrExecute(makeRequest("world"), async () => {
      calls++;
      return "b";
    });

    expect(result1).toBe("a");
    expect(result2).toBe("b");
    expect(calls).toBe(2);
  });

  test("cache is cleared after promise settles — second call re-executes", async () => {
    const cache = createInFlightCache<string>();
    let calls = 0;

    const execute = async (): Promise<string> => {
      calls++;
      return "value";
    };

    const req = makeRequest("sequential");
    await cache.getOrExecute(req, execute);
    await cache.getOrExecute(req, execute);

    expect(calls).toBe(2);
  });

  test("size() tracks active in-flight count", async () => {
    const cache = createInFlightCache<string>();

    expect(cache.size()).toBe(0);

    let resolve!: (v: string) => void;
    const pending = new Promise<string>((r) => {
      resolve = r;
    });

    const req = makeRequest("active");
    const p = cache.getOrExecute(req, () => pending);
    // Wait for the async hash computation (crypto.subtle) to complete and register the entry.
    // setTimeout(0) yields to the event loop, allowing all microtasks to drain.
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(cache.size()).toBe(1);
    resolve("done");
    await p;
    // Allow .finally() cleanup to run
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(cache.size()).toBe(0);
  });

  test("propagates errors and clears cache entry", async () => {
    const cache = createInFlightCache<string>();
    const req = makeRequest("failing");

    await expect(cache.getOrExecute(req, () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );

    // After failure, cache should be cleared — next call re-executes
    let calls = 0;
    await cache.getOrExecute(req, async () => {
      calls++;
      return "recovered";
    });
    expect(calls).toBe(1);
  });
});
