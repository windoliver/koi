import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistryCache } from "./cache.js";

function makeTmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-cache-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const sampleServer = {
  name: "io.example/foo",
  description: "Foo",
  version: "1.0.0",
} as const;

describe("createRegistryCache", () => {
  test("get returns undefined on cold cache", async () => {
    const { dir, cleanup } = makeTmp();
    try {
      const cache = createRegistryCache({ dir, ttlMs: 60_000 });
      expect(await cache.getSearch("git")).toBeUndefined();
      expect(await cache.getServer("io.example/foo")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("put then get round-trips a search result", async () => {
    const { dir, cleanup } = makeTmp();
    try {
      const cache = createRegistryCache({ dir, ttlMs: 60_000 });
      await cache.putSearch("git", { servers: [sampleServer], nextCursor: undefined });
      const got = await cache.getSearch("git");
      expect(got?.servers[0]?.name).toBe("io.example/foo");
    } finally {
      cleanup();
    }
  });

  test("put then get round-trips a server detail", async () => {
    const { dir, cleanup } = makeTmp();
    try {
      const cache = createRegistryCache({ dir, ttlMs: 60_000 });
      await cache.putServer("io.example/foo", sampleServer);
      const got = await cache.getServer("io.example/foo");
      expect(got?.name).toBe("io.example/foo");
    } finally {
      cleanup();
    }
  });

  test("expired entries are not returned", async () => {
    const { dir, cleanup } = makeTmp();
    try {
      const cache = createRegistryCache({ dir, ttlMs: 1, now: () => 1_000 });
      await cache.putSearch("git", { servers: [sampleServer], nextCursor: undefined });
      // Now jump forward beyond TTL. Use a fresh cache with same dir + later clock.
      const later = createRegistryCache({ dir, ttlMs: 1, now: () => 5_000 });
      expect(await later.getSearch("git")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("clear removes all entries", async () => {
    const { dir, cleanup } = makeTmp();
    try {
      const cache = createRegistryCache({ dir, ttlMs: 60_000 });
      await cache.putSearch("git", { servers: [sampleServer], nextCursor: undefined });
      await cache.putServer("io.example/foo", sampleServer);
      await cache.clear();
      expect(await cache.getSearch("git")).toBeUndefined();
      expect(await cache.getServer("io.example/foo")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("corrupt cache file is silently dropped, not thrown", async () => {
    const { dir, cleanup } = makeTmp();
    try {
      await Bun.write(join(dir, "mcp-registry.json"), "{not valid json");
      const cache = createRegistryCache({ dir, ttlMs: 60_000 });
      expect(await cache.getSearch("anything")).toBeUndefined();
      // Re-write should succeed.
      await cache.putSearch("git", { servers: [sampleServer], nextCursor: undefined });
      const got = await cache.getSearch("git");
      expect(got?.servers).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("different queries are isolated", async () => {
    const { dir, cleanup } = makeTmp();
    try {
      const cache = createRegistryCache({ dir, ttlMs: 60_000 });
      await cache.putSearch("git", { servers: [sampleServer], nextCursor: undefined });
      await cache.putSearch("docker", { servers: [], nextCursor: undefined });
      expect((await cache.getSearch("git"))?.servers).toHaveLength(1);
      expect((await cache.getSearch("docker"))?.servers).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
