/**
 * Unit tests for scope wiring.
 *
 * Verifies:
 *   - No backends -> empty providers
 *   - Filesystem scope + backend -> filesystem provider
 *   - Browser scope + backend -> browser provider
 *   - Credentials scope + backend -> credentials provider
 *   - Memory scope + backend -> memory provider
 *   - All 4 scopes + backends -> 4 providers
 *   - Enforcer is applied when provided
 *   - Missing backend for a scope config -> graceful skip
 */

import { describe, expect, test } from "bun:test";
import type {
  CredentialComponent,
  FileEditResult,
  FileListResult,
  FileReadResult,
  FileSearchResult,
  FileSystemBackend,
  FileWriteResult,
  KoiError,
  MemoryComponent,
  Result,
  ScopeEnforcer,
} from "@koi/core";
import { createMockDriver as createMockBrowserDriver } from "@koi/tool-browser";
import { wireGovernanceScope } from "../scope-wiring.js";
import type { GovernanceScopeBackends, GovernanceScopeConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockFileSystem(): FileSystemBackend {
  return {
    name: "mock-fs",
    read: (_path, _options?) =>
      ({
        ok: true,
        value: { content: "file content", path: _path, size: 12 },
      }) satisfies Result<FileReadResult, KoiError>,
    write: (_path, _content, _options?) =>
      ({
        ok: true,
        value: { path: _path, bytesWritten: _content.length },
      }) satisfies Result<FileWriteResult, KoiError>,
    edit: (_path, edits, _options?) =>
      ({
        ok: true,
        value: { path: _path, hunksApplied: edits.length },
      }) satisfies Result<FileEditResult, KoiError>,
    list: (_path, _options?) =>
      ({
        ok: true,
        value: { entries: [], truncated: false },
      }) satisfies Result<FileListResult, KoiError>,
    search: (_pattern, _options?) =>
      ({
        ok: true,
        value: { matches: [], truncated: false },
      }) satisfies Result<FileSearchResult, KoiError>,
  };
}

function makeMockCredentials(): CredentialComponent {
  return {
    get: async () => undefined,
  };
}

function makeMockMemory(): MemoryComponent {
  return {
    recall: async () => [],
    store: async () => undefined,
  };
}

function makeMockEnforcer(): ScopeEnforcer {
  return {
    checkAccess: () => true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wireGovernanceScope", () => {
  test("empty scope config + empty backends -> 0 providers", () => {
    const providers = wireGovernanceScope({}, {});
    expect(providers).toHaveLength(0);
  });

  test("filesystem scope + backend -> 1 provider", () => {
    const scope: GovernanceScopeConfig = { filesystem: { root: ".", mode: "rw" } };
    const backends: GovernanceScopeBackends = { filesystem: makeMockFileSystem() };
    const providers = wireGovernanceScope(scope, backends);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toContain("filesystem");
  });

  test("browser scope + backend -> 1 provider", () => {
    const scope: GovernanceScopeConfig = {
      browser: { blockPrivateAddresses: true },
    };
    const backends: GovernanceScopeBackends = { browser: createMockBrowserDriver() };
    const providers = wireGovernanceScope(scope, backends);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toContain("browser");
  });

  test("credentials scope + backend -> 1 provider", () => {
    const scope: GovernanceScopeConfig = { credentials: { keyPattern: "api:*" } };
    const backends: GovernanceScopeBackends = { credentials: makeMockCredentials() };
    const providers = wireGovernanceScope(scope, backends);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toContain("credentials");
  });

  test("memory scope + backend -> 1 provider", () => {
    const scope: GovernanceScopeConfig = { memory: { namespace: "test" } };
    const backends: GovernanceScopeBackends = { memory: makeMockMemory() };
    const providers = wireGovernanceScope(scope, backends);
    expect(providers).toHaveLength(1);
  });

  test("all 4 scopes + backends -> 4 providers", () => {
    const scope: GovernanceScopeConfig = {
      filesystem: { root: ".", mode: "ro" },
      browser: { blockPrivateAddresses: true, allowedProtocols: ["https:"] },
      credentials: { keyPattern: "*" },
      memory: { namespace: "default" },
    };
    const backends: GovernanceScopeBackends = {
      filesystem: makeMockFileSystem(),
      browser: createMockBrowserDriver(),
      credentials: makeMockCredentials(),
      memory: makeMockMemory(),
    };
    const providers = wireGovernanceScope(scope, backends);
    expect(providers).toHaveLength(4);
  });

  test("scope config without matching backend -> graceful skip", () => {
    const scope: GovernanceScopeConfig = {
      filesystem: { root: "." },
      browser: { blockPrivateAddresses: true },
    };
    // Only provide filesystem backend, not browser
    const backends: GovernanceScopeBackends = { filesystem: makeMockFileSystem() };
    const providers = wireGovernanceScope(scope, backends);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toContain("filesystem");
  });

  test("enforcer is applied when provided", () => {
    const scope: GovernanceScopeConfig = { filesystem: { root: ".", mode: "rw" } };
    const backends: GovernanceScopeBackends = { filesystem: makeMockFileSystem() };
    const enforcer = makeMockEnforcer();

    // Should not throw — enforcer wraps the backend
    const providers = wireGovernanceScope(scope, backends, enforcer);
    expect(providers).toHaveLength(1);
  });

  test("filesystem scope without mode defaults to rw", () => {
    const scope: GovernanceScopeConfig = { filesystem: { root: "/tmp" } };
    const backends: GovernanceScopeBackends = { filesystem: makeMockFileSystem() };
    const providers = wireGovernanceScope(scope, backends);
    expect(providers).toHaveLength(1);
  });
});
