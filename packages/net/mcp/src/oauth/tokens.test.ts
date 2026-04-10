import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SecureStorage } from "@koi/secure-storage";
import { computeServerKey, createTokenManager } from "./tokens.js";

// ---------------------------------------------------------------------------
// Mock storage
// ---------------------------------------------------------------------------

function createMockStorage(): SecureStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: mock(async (key: string) => data.get(key)),
    set: mock(async (key: string, value: string) => {
      data.set(key, value);
    }),
    delete: mock(async (key: string) => data.delete(key)),
    withLock: mock(async (_key: string, fn: () => Promise<unknown>) =>
      fn(),
    ) as SecureStorage["withLock"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeServerKey", () => {
  test("produces stable key from name + url", () => {
    const key1 = computeServerKey("github", "https://mcp.github.com");
    const key2 = computeServerKey("github", "https://mcp.github.com");
    expect(key1).toBe(key2);
  });

  test("different URLs produce different keys", () => {
    const key1 = computeServerKey("s", "https://a.com");
    const key2 = computeServerKey("s", "https://b.com");
    expect(key1).not.toBe(key2);
  });

  test("key format matches expected pattern", () => {
    const key = computeServerKey("my-server", "https://example.com");
    expect(key).toMatch(/^mcp-oauth\|my-server\|[a-f0-9]{16}$/);
  });
});

describe("createTokenManager", () => {
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    storage = createMockStorage();
  });

  test("hasTokens returns false when no tokens stored", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    expect(await tm.hasTokens()).toBe(false);
  });

  test("storeTokens then hasTokens returns true", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    await tm.storeTokens({
      accessToken: "tok123",
      expiresAt: Date.now() + 3600_000,
    });
    expect(await tm.hasTokens()).toBe(true);
  });

  test("getAccessToken returns stored token when not expired", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    await tm.storeTokens({
      accessToken: "valid-token",
      expiresAt: Date.now() + 3600_000,
    });
    const token = await tm.getAccessToken();
    expect(token).toBe("valid-token");
  });

  test("getAccessToken returns token when no expiresAt set", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    await tm.storeTokens({ accessToken: "no-expiry" });
    const token = await tm.getAccessToken();
    expect(token).toBe("no-expiry");
  });

  test("getAccessToken returns undefined when expired and no refresh token", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    await tm.storeTokens({
      accessToken: "expired",
      expiresAt: Date.now() - 1000,
    });
    const token = await tm.getAccessToken();
    expect(token).toBeUndefined();
  });

  test("clearTokens removes stored tokens", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    await tm.storeTokens({ accessToken: "to-delete" });
    expect(await tm.hasTokens()).toBe(true);
    await tm.clearTokens();
    expect(await tm.hasTokens()).toBe(false);
  });

  test("getAccessToken returns undefined when no tokens stored", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    const token = await tm.getAccessToken();
    expect(token).toBeUndefined();
  });

  test("storeTokens uses withLock for concurrent safety", async () => {
    const tm = createTokenManager({
      serverName: "test",
      serverUrl: "https://example.com",
      storage,
    });
    await tm.storeTokens({ accessToken: "locked" });
    expect(storage.withLock).toHaveBeenCalled();
  });
});
