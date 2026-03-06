import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { KoiMiddleware, ToolRequest, ToolResponse } from "@koi/core";
import { zoneId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { createFederationMiddleware } from "../federation-middleware.js";

function createRequest(overrides?: Partial<ToolRequest>): ToolRequest {
  return {
    toolId: "test-tool",
    input: { value: 42 },
    ...overrides,
  };
}

function createMockClient(): NexusClient & {
  readonly rpcMock: ReturnType<typeof mock>;
} {
  const rpcMock = mock(() =>
    Promise.resolve({
      ok: true as const,
      value: { output: "remote-result", metadata: {} } satisfies ToolResponse,
    }),
  );
  return {
    rpc: rpcMock as NexusClient["rpc"],
    rpcMock,
  };
}

function createCtx(targetZoneId?: string): {
  readonly metadata: Record<string, unknown>;
} {
  return {
    metadata: targetZoneId !== undefined ? { targetZoneId } : {},
  };
}

describe("createFederationMiddleware", () => {
  let remoteClient: ReturnType<typeof createMockClient>;
  let middleware: KoiMiddleware;
  const localZone = zoneId("zone-a");

  beforeEach(() => {
    remoteClient = createMockClient();
    middleware = createFederationMiddleware({
      localZoneId: localZone,
      remoteClients: new Map([["zone-b", remoteClient]]),
    });
  });

  test("passes through when no targetZoneId in context", async () => {
    const request = createRequest();
    const ctx = createCtx();
    const next = mock(() =>
      Promise.resolve({ output: "local", metadata: {} } satisfies ToolResponse),
    );

    const result = await middleware.wrapToolCall?.(ctx as never, request, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(result?.output).toBe("local");
    expect(remoteClient.rpcMock).not.toHaveBeenCalled();
  });

  test("passes through when targetZoneId matches localZoneId", async () => {
    const request = createRequest();
    const ctx = createCtx("zone-a");
    const next = mock(() =>
      Promise.resolve({ output: "local", metadata: {} } satisfies ToolResponse),
    );

    const result = await middleware.wrapToolCall?.(ctx as never, request, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(result?.output).toBe("local");
  });

  test("throws on unknown zone", async () => {
    const request = createRequest();
    const ctx = createCtx("zone-unknown");
    const next = mock(() =>
      Promise.resolve({ output: "local", metadata: {} } satisfies ToolResponse),
    );

    await expect(middleware.wrapToolCall?.(ctx as never, request, next)).rejects.toThrow(
      "Unknown target zone: zone-unknown",
    );
    expect(next).not.toHaveBeenCalled();
  });

  test("routes to remote zone on valid targetZoneId", async () => {
    const request = createRequest();
    const ctx = createCtx("zone-b");
    const next = mock(() => Promise.resolve({ output: "local" } satisfies ToolResponse));

    const result = await middleware.wrapToolCall?.(ctx as never, request, next);
    expect(next).not.toHaveBeenCalled();
    expect(remoteClient.rpcMock).toHaveBeenCalledTimes(1);
    expect(result?.output).toBe("remote-result");
  });

  test("throws on remote failure", async () => {
    remoteClient.rpcMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        error: { code: "TIMEOUT", message: "Timed out", retryable: true },
      }),
    );

    const request = createRequest();
    const ctx = createCtx("zone-b");
    const next = mock(() => Promise.resolve({ output: "local" } satisfies ToolResponse));

    await expect(middleware.wrapToolCall?.(ctx as never, request, next)).rejects.toThrow(
      "Remote zone zone-b failed: Timed out",
    );
  });

  test("calls onDelegated when routing to remote zone", async () => {
    const onDelegated = mock(() => {});
    const mw = createFederationMiddleware({
      localZoneId: localZone,
      remoteClients: new Map([["zone-b", remoteClient]]),
      onDelegated,
    });

    const request = createRequest();
    const ctx = createCtx("zone-b");
    const next = mock(() => Promise.resolve({ output: "local" } satisfies ToolResponse));

    await mw.wrapToolCall?.(ctx as never, request, next);
    expect(onDelegated).toHaveBeenCalledTimes(1);
    expect(onDelegated).toHaveBeenCalledWith("zone-b", request);
  });

  test("does not call onDelegated for local passthrough", async () => {
    const onDelegated = mock(() => {});
    const mw = createFederationMiddleware({
      localZoneId: localZone,
      remoteClients: new Map([["zone-b", remoteClient]]),
      onDelegated,
    });

    const request = createRequest();
    const ctx = createCtx();
    const next = mock(() => Promise.resolve({ output: "local" } satisfies ToolResponse));

    await mw.wrapToolCall?.(ctx as never, request, next);
    expect(onDelegated).not.toHaveBeenCalled();
  });

  test("describeCapabilities returns description when targetZoneId present", () => {
    const ctx = createCtx("zone-b");
    const result = middleware.describeCapabilities?.(ctx as never);
    expect(result?.label).toBe("federation");
  });

  test("describeCapabilities returns undefined when no targetZoneId", () => {
    const ctx = createCtx();
    const result = middleware.describeCapabilities?.(ctx as never);
    expect(result).toBeUndefined();
  });
});
