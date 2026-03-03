import { describe, expect, test } from "bun:test";
import type { Agent, ReputationBackend } from "@koi/core";
import { REPUTATION } from "@koi/core";

import { createReputationProvider } from "./component-provider.js";
import { createInMemoryReputationBackend } from "./in-memory-backend.js";

describe("createReputationProvider", () => {
  test("returns a provider with name 'reputation'", () => {
    const backend = createInMemoryReputationBackend();
    const provider = createReputationProvider(backend);
    expect(provider.name).toBe("reputation");
  });

  test("attach returns REPUTATION token in components map", async () => {
    const backend = createInMemoryReputationBackend();
    const provider = createReputationProvider(backend);
    const result = await provider.attach({} as Agent);

    expect("components" in result).toBe(true);
    if ("components" in result) {
      expect(result.components.has(REPUTATION as string)).toBe(true);
      expect(result.skipped).toHaveLength(0);
    }
  });

  test("attached component is the same backend instance", async () => {
    const backend = createInMemoryReputationBackend();
    const provider = createReputationProvider(backend);
    const result = await provider.attach({} as Agent);

    if ("components" in result) {
      const attached = result.components.get(REPUTATION as string) as ReputationBackend;
      expect(attached).toBe(backend);
    }
  });

  test("attach returns stable reference on repeated calls", async () => {
    const backend = createInMemoryReputationBackend();
    const provider = createReputationProvider(backend);
    const result1 = await provider.attach({} as Agent);
    const result2 = await provider.attach({} as Agent);
    expect(result1).toBe(result2);
  });

  test("detach calls backend dispose", async () => {
    let disposed = false;
    const mockBackend: ReputationBackend = {
      record: () => ({ ok: true, value: undefined }),
      getScore: () => ({ ok: true, value: undefined }),
      query: () => ({ ok: true, value: { entries: [], hasMore: false } }),
      dispose: () => {
        disposed = true;
      },
    };

    const provider = createReputationProvider(mockBackend);
    await provider.detach?.({} as Agent);
    expect(disposed).toBe(true);
  });
});
