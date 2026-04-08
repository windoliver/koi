/**
 * TDD tests for skills-mcp bridge — connects McpResolver to SkillsRuntime.
 *
 * Covers:
 * - Mapping: ToolDescriptor → SkillMetadata (name, source, dirPath, tags)
 * - sync(): initial discovery + registerExternal
 * - onChange: re-sync on tool list changes
 * - dispose(): unsubscribe + clear stale skills
 * - Race safety: dispose during sync, onChange during sync
 * - Edge cases: empty tools, no server field, idempotent subscription
 */
import { describe, expect, mock, test } from "bun:test";
import type { ToolDescriptor } from "@koi/core";
import type { McpResolver } from "@koi/mcp";
import type { SkillMetadata, SkillsRuntime } from "@koi/skills-runtime";
import { createSkillsMcpBridge, mapToolDescriptorToSkillMetadata } from "./skills-mcp-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function descriptor(name: string, server?: string, tags?: readonly string[]): ToolDescriptor {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    ...(server !== undefined ? { server } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };
}

interface MockResolver {
  readonly discover: ReturnType<typeof mock>;
  readonly load: ReturnType<typeof mock>;
  readonly onChange: ReturnType<typeof mock>;
  readonly dispose: ReturnType<typeof mock>;
  readonly failures: readonly never[];
  /** Fire the captured onChange listener. */
  readonly fireChange: () => void;
}

function createMockResolver(tools: readonly ToolDescriptor[] = []): MockResolver {
  let listener: (() => void) | undefined;
  const unsubscribe = mock(() => {
    listener = undefined;
  });

  return {
    discover: mock(() => Promise.resolve(tools)),
    load: mock(() =>
      Promise.resolve({
        ok: false,
        error: { code: "NOT_FOUND", message: "stub", retryable: false },
      }),
    ),
    onChange: mock((fn: () => void) => {
      listener = fn;
      return unsubscribe;
    }),
    dispose: mock(() => {}),
    failures: [],
    fireChange: () => listener?.(),
  };
}

function createMockRuntime(): { readonly registerExternal: ReturnType<typeof mock> } {
  return {
    registerExternal: mock((_skills: readonly SkillMetadata[]) => {}),
  };
}

// ---------------------------------------------------------------------------
// mapToolDescriptorToSkillMetadata
// ---------------------------------------------------------------------------

describe("mapToolDescriptorToSkillMetadata", () => {
  test("maps descriptor with server field", () => {
    const td = descriptor("myserver__search", "myserver", ["ai"]);
    const result = mapToolDescriptorToSkillMetadata(td);

    expect(result.name).toBe("myserver__search");
    expect(result.description).toBe("Tool myserver__search");
    expect(result.source).toBe("mcp");
    expect(result.dirPath).toBe("mcp://myserver");
    expect(result.tags).toEqual(["mcp", "myserver", "ai"]);
  });

  test("maps descriptor without server field", () => {
    const td = descriptor("orphan__tool");
    const result = mapToolDescriptorToSkillMetadata(td);

    expect(result.dirPath).toBe("mcp://unknown");
    expect(result.tags).toEqual(["mcp"]);
  });

  test("maps descriptor without tags", () => {
    const td = descriptor("srv__tool", "srv");
    const result = mapToolDescriptorToSkillMetadata(td);

    expect(result.tags).toEqual(["mcp", "srv"]);
  });

  test("does not include executionMode (runtime default)", () => {
    const td = descriptor("srv__tool", "srv");
    const result = mapToolDescriptorToSkillMetadata(td);

    expect(result.executionMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createSkillsMcpBridge
// ---------------------------------------------------------------------------

describe("createSkillsMcpBridge", () => {
  // -- sync: basic -----------------------------------------------------------

  test("sync() maps ToolDescriptors and calls registerExternal", async () => {
    const resolver = createMockResolver([
      descriptor("alpha__search", "alpha"),
      descriptor("beta__read", "beta", ["io"]),
    ]);
    const runtime = createMockRuntime();
    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime: runtime as unknown as SkillsRuntime,
    });

    await bridge.sync();

    expect(resolver.discover).toHaveBeenCalledTimes(1);
    expect(runtime.registerExternal).toHaveBeenCalledTimes(1);

    const skills = runtime.registerExternal.mock.calls[0]?.[0] as readonly SkillMetadata[];
    expect(skills).toHaveLength(2);
    expect(skills[0]?.name).toBe("alpha__search");
    expect(skills[0]?.source).toBe("mcp");
    expect(skills[0]?.dirPath).toBe("mcp://alpha");
    expect(skills[1]?.tags).toEqual(["mcp", "beta", "io"]);
  });

  test("sync() with empty tool list calls registerExternal([])", async () => {
    const resolver = createMockResolver([]);
    const runtime = createMockRuntime();
    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime: runtime as unknown as SkillsRuntime,
    });

    await bridge.sync();

    expect(runtime.registerExternal).toHaveBeenCalledTimes(1);
    const skills = runtime.registerExternal.mock.calls[0]?.[0] as readonly SkillMetadata[];
    expect(skills).toHaveLength(0);
  });

  // -- onChange ---------------------------------------------------------------

  test("onChange triggers re-sync with updated tools", async () => {
    const initialTools = [descriptor("srv__a", "srv")];
    const resolver = createMockResolver(initialTools);
    const runtime = createMockRuntime();
    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime: runtime as unknown as SkillsRuntime,
    });

    await bridge.sync();
    expect(runtime.registerExternal).toHaveBeenCalledTimes(1);

    // Update tools and fire onChange
    const updatedTools = [descriptor("srv__a", "srv"), descriptor("srv__b", "srv")];
    resolver.discover.mockImplementation(() => Promise.resolve(updatedTools));
    resolver.fireChange();

    // Wait for async re-sync
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runtime.registerExternal).toHaveBeenCalledTimes(2);
    const skills = runtime.registerExternal.mock.calls[1]?.[0] as readonly SkillMetadata[];
    expect(skills).toHaveLength(2);
  });

  test("server disconnect clears skills via onChange", async () => {
    const resolver = createMockResolver([descriptor("srv__tool", "srv")]);
    const runtime = createMockRuntime();
    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime: runtime as unknown as SkillsRuntime,
    });

    await bridge.sync();

    // Server disconnects — discover returns empty
    resolver.discover.mockImplementation(() => Promise.resolve([]));
    resolver.fireChange();

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runtime.registerExternal).toHaveBeenCalledTimes(2);
    const skills = runtime.registerExternal.mock.calls[1]?.[0] as readonly SkillMetadata[];
    expect(skills).toHaveLength(0);
  });

  // -- subscription idempotency ----------------------------------------------

  test("sync() is idempotent for onChange subscription", async () => {
    const resolver = createMockResolver([]);
    const runtime = createMockRuntime();
    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime: runtime as unknown as SkillsRuntime,
    });

    await bridge.sync();
    await bridge.sync();

    // onChange subscribed only once
    expect(resolver.onChange).toHaveBeenCalledTimes(1);
  });

  // -- dispose ---------------------------------------------------------------

  test("dispose() unsubscribes and clears skills", async () => {
    const resolver = createMockResolver([descriptor("srv__tool", "srv")]);
    const runtime = createMockRuntime();
    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime: runtime as unknown as SkillsRuntime,
    });

    await bridge.sync();
    bridge.dispose();

    // registerExternal called twice: once for sync, once for dispose([])
    expect(runtime.registerExternal).toHaveBeenCalledTimes(2);
    const clearCall = runtime.registerExternal.mock.calls[1]?.[0] as readonly SkillMetadata[];
    expect(clearCall).toHaveLength(0);
  });

  test("dispose() before sync() is safe", () => {
    const resolver = createMockResolver([]);
    const runtime = createMockRuntime();
    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime: runtime as unknown as SkillsRuntime,
    });

    // Should not throw
    bridge.dispose();

    // registerExternal([]) called for cleanup
    expect(runtime.registerExternal).toHaveBeenCalledTimes(1);
    const skills = runtime.registerExternal.mock.calls[0]?.[0] as readonly SkillMetadata[];
    expect(skills).toHaveLength(0);
  });

  // -- race safety -----------------------------------------------------------

  test("dispose during sync prevents stale registerExternal", async () => {
    // Resolver discover() takes time
    const resolver = createMockResolver([]);
    resolver.discover.mockImplementation(
      () =>
        new Promise((resolve) => setTimeout(() => resolve([descriptor("srv__tool", "srv")]), 50)),
    );
    const runtime = createMockRuntime();
    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime: runtime as unknown as SkillsRuntime,
    });

    const syncPromise = bridge.sync();
    // Dispose before discover resolves
    bridge.dispose();
    await syncPromise;

    // Only the dispose clear call should have registered, not the stale discover result
    const calls = runtime.registerExternal.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as readonly SkillMetadata[];
    expect(lastCall).toHaveLength(0);
  });

  test("onChange during sync sets dirty flag for re-sync", async () => {
    let discoverCount = 0;
    const resolver = createMockResolver([]);
    resolver.discover.mockImplementation(() => {
      discoverCount++;
      if (discoverCount === 1) {
        return new Promise((resolve) =>
          setTimeout(() => resolve([descriptor("srv__a", "srv")]), 30),
        );
      }
      return Promise.resolve([descriptor("srv__a", "srv"), descriptor("srv__b", "srv")]);
    });
    const runtime = createMockRuntime();
    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime: runtime as unknown as SkillsRuntime,
    });

    const syncPromise = bridge.sync();

    // Fire onChange while first sync is in flight (after subscription but during discover)
    await new Promise((resolve) => setTimeout(resolve, 5));
    resolver.fireChange();

    await syncPromise;
    // Wait for the dirty re-sync
    await new Promise((resolve) => setTimeout(resolve, 50));

    // discover called at least twice (initial + dirty re-sync)
    expect(discoverCount).toBeGreaterThanOrEqual(2);
    // Last registerExternal should have 2 tools
    const calls = runtime.registerExternal.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as readonly SkillMetadata[];
    expect(lastCall).toHaveLength(2);
  });

  test("concurrent sync() callers join the same in-flight promise", async () => {
    const resolver = createMockResolver([]);
    resolver.discover.mockImplementation(() => Promise.resolve([descriptor("srv__tool", "srv")]));
    const runtime = createMockRuntime();
    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime: runtime as unknown as SkillsRuntime,
    });

    // Two concurrent sync() calls — second joins the in-flight promise
    const p1 = bridge.sync();
    const p2 = bridge.sync();
    await Promise.all([p1, p2]);

    // Both callers resolved, registerExternal was called
    expect(runtime.registerExternal).toHaveBeenCalled();
    // All calls should have tools (no empty stale result)
    const lastCall = runtime.registerExternal.mock.calls[
      runtime.registerExternal.mock.calls.length - 1
    ]?.[0] as readonly SkillMetadata[] | undefined;
    expect(lastCall?.length).toBeGreaterThan(0);
  });

  test("concurrent sync() callers both see startup failure", async () => {
    const resolver = createMockResolver([]);
    resolver.discover.mockImplementation(() => Promise.reject(new Error("fail")));
    const runtime = createMockRuntime();
    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime: runtime as unknown as SkillsRuntime,
    });

    const p1 = bridge.sync();
    const p2 = bridge.sync();

    // Both callers see the rejection
    const results = await Promise.allSettled([p1, p2]);
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("rejected");
  });

  // -- error handling --------------------------------------------------------

  test("onChange clears stale skills on discover() error and calls onSyncError", async () => {
    const resolver = createMockResolver([descriptor("srv__tool", "srv")]);
    const runtime = createMockRuntime();
    const onSyncError = mock((_error: unknown) => {});
    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime: runtime as unknown as SkillsRuntime,
      onSyncError,
    });

    await bridge.sync();
    expect(runtime.registerExternal).toHaveBeenCalledTimes(1);

    // Next discover throws
    resolver.discover.mockImplementation(() => Promise.reject(new Error("connection lost")));
    resolver.fireChange();

    // Should not throw; wait for async handler
    await new Promise((resolve) => setTimeout(resolve, 10));

    // registerExternal called twice: initial sync + clear on error
    expect(runtime.registerExternal).toHaveBeenCalledTimes(2);
    const clearCall = runtime.registerExternal.mock.calls[1]?.[0] as readonly SkillMetadata[];
    expect(clearCall).toHaveLength(0);

    // onSyncError callback invoked
    expect(onSyncError).toHaveBeenCalledTimes(1);
  });

  test("initial sync() propagates discover() errors to the caller", async () => {
    const resolver = createMockResolver([]);
    resolver.discover.mockImplementation(() => Promise.reject(new Error("startup failure")));
    const runtime = createMockRuntime();
    const bridge = createSkillsMcpBridge({
      resolver: resolver as unknown as McpResolver,
      runtime: runtime as unknown as SkillsRuntime,
    });

    await expect(bridge.sync()).rejects.toThrow("startup failure");

    // Skills cleared on failure
    expect(runtime.registerExternal).toHaveBeenCalledTimes(1);
    const clearCall = runtime.registerExternal.mock.calls[0]?.[0] as readonly SkillMetadata[];
    expect(clearCall).toHaveLength(0);
  });
});
