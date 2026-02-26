import { describe, expect, test } from "bun:test";
import type {
  BrowserDriver,
  CredentialComponent,
  FileSystemBackend,
  MemoryComponent,
  MemoryRecallOptions,
  MemoryResult,
  MemoryStoreOptions,
  ScopeEnforcer,
} from "@koi/core";
import type { ManifestScopeConfig } from "@koi/manifest";
import { resolveManifestScope } from "./scope-resolver.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockFsBackend(name = "mock-fs"): FileSystemBackend {
  return {
    name,
    read: () => ({ ok: true, value: { content: "", path: "", size: 0 } }),
    write: () => ({ ok: true, value: { path: "", bytesWritten: 0 } }),
    edit: () => ({ ok: true, value: { path: "", hunksApplied: 0 } }),
    list: () => ({ ok: true, value: { entries: [], truncated: false } }),
    search: () => ({ ok: true, value: { matches: [], truncated: false } }),
  };
}

function createMockBrowserDriver(name = "mock-browser"): BrowserDriver {
  return {
    name,
    snapshot: () => ({
      ok: true,
      value: { snapshot: "", snapshotId: "s1", refs: {}, truncated: false, url: "", title: "" },
    }),
    navigate: (url) => ({ ok: true, value: { url, title: "Page" } }),
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
    evaluate: () => ({ ok: true, value: { value: undefined } }),
    hover: () => ({ ok: true, value: undefined }),
    press: () => ({ ok: true, value: undefined }),
    tabList: () => ({ ok: true, value: [] }),
    console: () => ({ ok: true, value: { entries: [], total: 0 } }),
  };
}

function createMockCredentials(): CredentialComponent {
  return {
    async get(): Promise<string | undefined> {
      return "secret";
    },
  };
}

function createMockMemory(): MemoryComponent {
  return {
    async store(_content: string, _options?: MemoryStoreOptions): Promise<void> {},
    async recall(_query: string, _options?: MemoryRecallOptions): Promise<readonly MemoryResult[]> {
      return [];
    },
  };
}

function createMockEnforcer(): ScopeEnforcer {
  return {
    checkAccess: () => true,
  };
}

// ---------------------------------------------------------------------------
// resolveManifestScope
// ---------------------------------------------------------------------------

describe("resolveManifestScope", () => {
  test("creates filesystem provider from scope config + backend", () => {
    const scopeConfig: ManifestScopeConfig = {
      filesystem: { root: "/workspace", mode: "ro" },
    };
    const providers = resolveManifestScope(scopeConfig, {
      filesystem: createMockFsBackend(),
    });
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toContain("filesystem");
  });

  test("creates browser provider from scope config + backend", () => {
    const scopeConfig: ManifestScopeConfig = {
      browser: {
        allowedDomains: ["example.com"],
        blockPrivateAddresses: true,
      },
    };
    const providers = resolveManifestScope(scopeConfig, {
      browser: createMockBrowserDriver(),
    });
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toContain("browser");
  });

  test("creates credentials provider from scope config", () => {
    const scopeConfig: ManifestScopeConfig = {
      credentials: { keyPattern: "API_*" },
    };
    const providers = resolveManifestScope(scopeConfig, {
      credentials: createMockCredentials(),
    });
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toContain("scoped-credentials");
  });

  test("creates memory provider from scope config", () => {
    const scopeConfig: ManifestScopeConfig = {
      memory: { namespace: "test-ns" },
    };
    const providers = resolveManifestScope(scopeConfig, {
      memory: createMockMemory(),
    });
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toContain("scoped-memory");
  });

  test("creates multiple providers when multiple scopes configured", () => {
    const scopeConfig: ManifestScopeConfig = {
      filesystem: { root: "/workspace" },
      browser: { allowedDomains: ["example.com"] },
      credentials: { keyPattern: "*" },
      memory: { namespace: "ns" },
    };
    const providers = resolveManifestScope(scopeConfig, {
      filesystem: createMockFsBackend(),
      browser: createMockBrowserDriver(),
      credentials: createMockCredentials(),
      memory: createMockMemory(),
    });
    expect(providers).toHaveLength(4);
  });

  test("returns empty array when no scope config fields", () => {
    const scopeConfig: ManifestScopeConfig = {};
    const providers = resolveManifestScope(scopeConfig, {
      filesystem: createMockFsBackend(),
    });
    expect(providers).toHaveLength(0);
  });

  test("returns empty array when no matching backends", () => {
    const scopeConfig: ManifestScopeConfig = {
      filesystem: { root: "/workspace" },
      browser: { allowedDomains: ["example.com"] },
    };
    // Provide no backends
    const providers = resolveManifestScope(scopeConfig, {});
    expect(providers).toHaveLength(0);
  });

  test("applies enforcer when provided", () => {
    const scopeConfig: ManifestScopeConfig = {
      filesystem: { root: "/workspace" },
    };
    const enforcer = createMockEnforcer();
    const providers = resolveManifestScope(
      scopeConfig,
      { filesystem: createMockFsBackend() },
      enforcer,
    );
    expect(providers).toHaveLength(1);
    // The provider wraps with enforced backend (name includes "enforced")
    // We can verify it was created without error
    expect(providers[0]?.name).toBeDefined();
  });

  test("skips tokens without matching backend", () => {
    const scopeConfig: ManifestScopeConfig = {
      filesystem: { root: "/workspace" },
      memory: { namespace: "ns" },
    };
    // Only provide filesystem backend, not memory
    const providers = resolveManifestScope(scopeConfig, {
      filesystem: createMockFsBackend(),
    });
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toContain("filesystem");
  });

  test("filesystem scope defaults mode to rw when not specified", () => {
    const scopeConfig: ManifestScopeConfig = {
      filesystem: { root: "/workspace" },
    };
    const providers = resolveManifestScope(scopeConfig, {
      filesystem: createMockFsBackend(),
    });
    // Should not throw — mode defaults to "rw"
    expect(providers).toHaveLength(1);
  });

  test("browser scope maps allowedDomains to navigation config", () => {
    const scopeConfig: ManifestScopeConfig = {
      browser: {
        allowedDomains: ["example.com"],
        allowedProtocols: ["https:"],
        blockPrivateAddresses: true,
        trustTier: "verified",
      },
    };
    const providers = resolveManifestScope(scopeConfig, {
      browser: createMockBrowserDriver(),
    });
    expect(providers).toHaveLength(1);
  });
});
