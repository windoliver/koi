import { describe, expect, mock, test } from "bun:test";
import type { LspClient } from "./client.js";
import { createLspClientPool, DEFAULT_LSP_CLIENT_POOL_CONFIG } from "./client-pool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLspClient(name: string = "test"): LspClient {
  return {
    close: mock(async () => {}),
    serverName: () => name,
    isConnected: () => true,
  } as unknown as LspClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLspClientPool", () => {
  test("acquire returns undefined for unknown server", () => {
    const pool = createLspClientPool(DEFAULT_LSP_CLIENT_POOL_CONFIG);
    expect(pool.acquire("unknown")).toBeUndefined();
  });

  test("release then acquire returns the same client", () => {
    const pool = createLspClientPool(DEFAULT_LSP_CLIENT_POOL_CONFIG);
    const client = createMockLspClient();
    pool.release("ts", client);
    expect(pool.size()).toBe(1);
    const acquired = pool.acquire("ts");
    expect(acquired).toBe(client);
    expect(pool.size()).toBe(0);
  });

  test("acquire removes client from pool", () => {
    const pool = createLspClientPool(DEFAULT_LSP_CLIENT_POOL_CONFIG);
    const client = createMockLspClient();
    pool.release("ts", client);
    pool.acquire("ts");
    expect(pool.acquire("ts")).toBeUndefined();
  });

  test("evict closes the client", async () => {
    const pool = createLspClientPool(DEFAULT_LSP_CLIENT_POOL_CONFIG);
    const client = createMockLspClient();
    pool.release("ts", client);
    await pool.evict("ts");
    expect(pool.size()).toBe(0);
    expect(client.close).toHaveBeenCalled();
  });

  test("evict is no-op for unknown server", async () => {
    const pool = createLspClientPool(DEFAULT_LSP_CLIENT_POOL_CONFIG);
    await pool.evict("unknown"); // Should not throw
  });

  test("dispose closes all clients", async () => {
    const pool = createLspClientPool(DEFAULT_LSP_CLIENT_POOL_CONFIG);
    const c1 = createMockLspClient("ts");
    const c2 = createMockLspClient("py");
    pool.release("ts", c1);
    pool.release("py", c2);
    expect(pool.size()).toBe(2);
    await pool.dispose();
    expect(pool.size()).toBe(0);
    expect(c1.close).toHaveBeenCalled();
    expect(c2.close).toHaveBeenCalled();
  });

  test("respects maxClients by evicting oldest", async () => {
    const pool = createLspClientPool({
      enabled: true,
      maxClients: 2,
      idleTimeoutMs: 60_000,
    });
    const c1 = createMockLspClient("a");
    const c2 = createMockLspClient("b");
    const c3 = createMockLspClient("c");
    pool.release("a", c1);
    pool.release("b", c2);
    pool.release("c", c3); // Should evict "a"
    expect(pool.size()).toBe(2);
    expect(pool.acquire("a")).toBeUndefined(); // Evicted
    expect(pool.acquire("c")).toBe(c3);
  });

  test("disabled pool always returns undefined", () => {
    const pool = createLspClientPool({
      enabled: false,
      maxClients: 4,
      idleTimeoutMs: 60_000,
    });
    const client = createMockLspClient();
    pool.release("ts", client);
    expect(pool.acquire("ts")).toBeUndefined();
    expect(client.close).toHaveBeenCalled(); // Should close immediately
  });
});
