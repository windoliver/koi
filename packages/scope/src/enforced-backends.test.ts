import { describe, expect, test } from "bun:test";
import type {
  BrowserDriver,
  CredentialComponent,
  FileSystemBackend,
  KoiError,
  MemoryComponent,
  MemoryRecallOptions,
  MemoryResult,
  MemoryStoreOptions,
  Result,
  ScopeAccessRequest,
  ScopeEnforcer,
} from "@koi/core";
import {
  createEnforcedBrowser,
  createEnforcedCredentials,
  createEnforcedFileSystem,
  createEnforcedMemory,
} from "./enforced-backends.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEnforcer(allowed: boolean): ScopeEnforcer & {
  readonly requests: readonly ScopeAccessRequest[];
} {
  const requests: ScopeAccessRequest[] = [];
  return {
    checkAccess(request: ScopeAccessRequest): boolean {
      requests.push(request);
      return allowed;
    },
    requests,
  };
}

function createAsyncMockEnforcer(allowed: boolean): ScopeEnforcer & {
  readonly requests: readonly ScopeAccessRequest[];
} {
  const requests: ScopeAccessRequest[] = [];
  return {
    async checkAccess(request: ScopeAccessRequest): Promise<boolean> {
      requests.push(request);
      return allowed;
    },
    requests,
  };
}

function createMockBackend(name = "mock"): FileSystemBackend {
  return {
    name,
    read(p) {
      return { ok: true, value: { content: "", path: p, size: 0 } };
    },
    write(p, _content) {
      return { ok: true, value: { path: p, bytesWritten: 0 } };
    },
    edit(p, _edits) {
      return { ok: true, value: { path: p, hunksApplied: 0 } };
    },
    list(_p) {
      return { ok: true, value: { entries: [], truncated: false } };
    },
    search(_pattern) {
      return { ok: true, value: { matches: [], truncated: false } };
    },
    delete(p) {
      return { ok: true, value: { path: p } };
    },
    rename(from, to) {
      return { ok: true, value: { from, to } };
    },
  };
}

function createMockDriver(name = "mock"): BrowserDriver & {
  readonly navigatedUrls: readonly string[];
} {
  const navigatedUrls: string[] = [];
  return {
    name,
    snapshot: () => ({
      ok: true,
      value: { snapshot: "", snapshotId: "s1", refs: {}, truncated: false, url: "", title: "" },
    }),
    navigate: (url) => {
      navigatedUrls.push(url);
      return { ok: true, value: { url, title: "Page" } };
    },
    click: () => ({ ok: true, value: undefined }),
    type: () => ({ ok: true, value: undefined }),
    select: () => ({ ok: true, value: undefined }),
    fillForm: () => ({ ok: true, value: undefined }),
    scroll: () => ({ ok: true, value: undefined }),
    screenshot: () => ({
      ok: true,
      value: { data: "", mimeType: "image/png" as const, width: 100, height: 100 },
    }),
    wait: () => ({ ok: true, value: undefined }),
    tabNew: () => ({ ok: true, value: { tabId: "t1", url: "", title: "" } }),
    tabClose: () => ({ ok: true, value: undefined }),
    tabFocus: () => ({ ok: true, value: { tabId: "t1", url: "", title: "" } }),
    evaluate: (_script) => ({ ok: true, value: { value: undefined } }),
    hover: () => ({ ok: true, value: undefined }),
    press: () => ({ ok: true, value: undefined }),
    tabList: () => ({ ok: true, value: [] }),
    console: () => ({ ok: true, value: { entries: [], total: 0 } }),
    navigatedUrls,
  };
}

function createMockCredentials(store: Readonly<Record<string, string>>): CredentialComponent {
  return {
    async get(key: string): Promise<string | undefined> {
      return store[key];
    },
  };
}

function createMockMemory(): MemoryComponent & {
  readonly storeCalls: readonly { content: string; options?: MemoryStoreOptions }[];
} {
  const storeCalls: { content: string; options?: MemoryStoreOptions }[] = [];
  return {
    async store(content: string, options?: MemoryStoreOptions): Promise<void> {
      storeCalls.push(options !== undefined ? { content, options } : { content });
    },
    async recall(_query: string, _options?: MemoryRecallOptions): Promise<readonly MemoryResult[]> {
      return [
        { content: "result-1", score: 0.9 },
        { content: "result-2", score: 0.8 },
      ];
    },
    storeCalls,
  };
}

function isErr(
  r: Result<unknown, KoiError>,
): r is { readonly ok: false; readonly error: KoiError } {
  return !r.ok;
}

// ---------------------------------------------------------------------------
// createEnforcedFileSystem
// ---------------------------------------------------------------------------

describe("createEnforcedFileSystem", () => {
  test("passes through read when enforcer allows", async () => {
    const backend = createMockBackend();
    const enforcer = createMockEnforcer(true);
    const enforced = createEnforcedFileSystem(backend, enforcer);

    const result = await enforced.read("/foo.txt");
    expect(result.ok).toBe(true);
  });

  test("blocks read when enforcer denies", async () => {
    const backend = createMockBackend();
    const enforcer = createMockEnforcer(false);
    const enforced = createEnforcedFileSystem(backend, enforcer);

    const result = await enforced.read("/foo.txt");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("blocks write when enforcer denies", async () => {
    const backend = createMockBackend();
    const enforcer = createMockEnforcer(false);
    const enforced = createEnforcedFileSystem(backend, enforcer);

    const result = await enforced.write("/foo.txt", "data");
    expect(isErr(result)).toBe(true);
  });

  test("passes correct subsystem/operation/resource to enforcer", async () => {
    const backend = createMockBackend();
    const enforcer = createMockEnforcer(true);
    const enforced = createEnforcedFileSystem(backend, enforcer);

    await enforced.read("/foo.txt");
    expect(enforcer.requests).toHaveLength(1);
    expect(enforcer.requests[0]).toEqual({
      subsystem: "filesystem",
      operation: "read",
      resource: "/foo.txt",
    });
  });

  test("handles async enforcer (Promise return)", async () => {
    const backend = createMockBackend();
    const enforcer = createAsyncMockEnforcer(true);
    const enforced = createEnforcedFileSystem(backend, enforcer);

    const result = await enforced.read("/foo.txt");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createEnforcedBrowser
// ---------------------------------------------------------------------------

describe("createEnforcedBrowser", () => {
  test("passes through navigate when enforcer allows", async () => {
    const driver = createMockDriver();
    const enforcer = createMockEnforcer(true);
    const enforced = createEnforcedBrowser(driver, enforcer);

    const result = await enforced.navigate("https://example.com");
    expect(result.ok).toBe(true);
    expect(driver.navigatedUrls).toEqual(["https://example.com"]);
  });

  test("blocks navigate when enforcer denies", async () => {
    const driver = createMockDriver();
    const enforcer = createMockEnforcer(false);
    const enforced = createEnforcedBrowser(driver, enforcer);

    const result = await enforced.navigate("https://evil.com");
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe("PERMISSION");
    }
    expect(driver.navigatedUrls).toHaveLength(0);
  });

  test("passes through non-URL methods without enforcer check", async () => {
    const driver = createMockDriver();
    const enforcer = createMockEnforcer(false); // deny all
    const enforced = createEnforcedBrowser(driver, enforcer);

    // click, type, hover etc. should pass through
    const clickResult = await enforced.click("button");
    expect(clickResult.ok).toBe(true);
    // enforcer should not be called for click
    expect(enforcer.requests).toHaveLength(0);
  });

  test("passes correct subsystem/operation/resource for navigate", async () => {
    const driver = createMockDriver();
    const enforcer = createMockEnforcer(true);
    const enforced = createEnforcedBrowser(driver, enforcer);

    await enforced.navigate("https://example.com/page");
    expect(enforcer.requests[0]).toEqual({
      subsystem: "browser",
      operation: "navigate",
      resource: "https://example.com/page",
    });
  });

  test("checks enforcer for tabNew with URL", async () => {
    const driver = createMockDriver();
    const enforcer = createMockEnforcer(false);
    const enforced = createEnforcedBrowser(driver, enforcer);

    const result = await enforced.tabNew({ url: "https://blocked.com" });
    expect(isErr(result)).toBe(true);
  });

  test("skips enforcer for tabNew without URL", async () => {
    const driver = createMockDriver();
    const enforcer = createMockEnforcer(false); // deny all
    const enforced = createEnforcedBrowser(driver, enforcer);

    const result = await enforced.tabNew();
    // Should pass through since no URL to check
    expect(result.ok).toBe(true);
    expect(enforcer.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createEnforcedCredentials
// ---------------------------------------------------------------------------

describe("createEnforcedCredentials", () => {
  test("returns value when enforcer allows", async () => {
    const creds = createMockCredentials({ MY_KEY: "secret" });
    const enforcer = createMockEnforcer(true);
    const enforced = createEnforcedCredentials(creds, enforcer);

    const value = await enforced.get("MY_KEY");
    expect(value).toBe("secret");
  });

  test("returns undefined when enforcer denies", async () => {
    const creds = createMockCredentials({ MY_KEY: "secret" });
    const enforcer = createMockEnforcer(false);
    const enforced = createEnforcedCredentials(creds, enforcer);

    const value = await enforced.get("MY_KEY");
    expect(value).toBeUndefined();
  });

  test("passes correct subsystem/operation/resource", async () => {
    const creds = createMockCredentials({ API_KEY: "val" });
    const enforcer = createMockEnforcer(true);
    const enforced = createEnforcedCredentials(creds, enforcer);

    await enforced.get("API_KEY");
    expect(enforcer.requests[0]).toEqual({
      subsystem: "credentials",
      operation: "get",
      resource: "API_KEY",
    });
  });
});

// ---------------------------------------------------------------------------
// createEnforcedMemory
// ---------------------------------------------------------------------------

describe("createEnforcedMemory", () => {
  test("passes through store when enforcer allows", async () => {
    const memory = createMockMemory();
    const enforcer = createMockEnforcer(true);
    const enforced = createEnforcedMemory(memory, enforcer);

    await enforced.store("data", { namespace: "ns1" });
    expect(memory.storeCalls).toHaveLength(1);
    expect(memory.storeCalls[0]?.content).toBe("data");
  });

  test("blocks store when enforcer denies", async () => {
    const memory = createMockMemory();
    const enforcer = createMockEnforcer(false);
    const enforced = createEnforcedMemory(memory, enforcer);

    await enforced.store("data", { namespace: "ns1" });
    // Should not reach the backend
    expect(memory.storeCalls).toHaveLength(0);
  });

  test("returns results when enforcer allows recall", async () => {
    const memory = createMockMemory();
    const enforcer = createMockEnforcer(true);
    const enforced = createEnforcedMemory(memory, enforcer);

    const results = await enforced.recall("query");
    expect(results).toHaveLength(2);
  });

  test("returns empty array when enforcer denies recall", async () => {
    const memory = createMockMemory();
    const enforcer = createMockEnforcer(false);
    const enforced = createEnforcedMemory(memory, enforcer);

    const results = await enforced.recall("query");
    expect(results).toHaveLength(0);
  });

  test("passes correct subsystem/operation/resource for store", async () => {
    const memory = createMockMemory();
    const enforcer = createMockEnforcer(true);
    const enforced = createEnforcedMemory(memory, enforcer);

    await enforced.store("data", { namespace: "my-ns" });
    expect(enforcer.requests[0]).toEqual({
      subsystem: "memory",
      operation: "store",
      resource: "my-ns",
    });
  });

  test("uses default resource when namespace not provided", async () => {
    const memory = createMockMemory();
    const enforcer = createMockEnforcer(true);
    const enforced = createEnforcedMemory(memory, enforcer);

    await enforced.store("data");
    expect(enforcer.requests[0]?.resource).toBe("default");
  });
});
