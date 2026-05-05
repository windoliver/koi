import { describe, expect, test } from "bun:test";
import type {
  JsonObject,
  KoiError,
  Result,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { runId, sessionId, zoneId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createFederationMiddleware } from "./federation-middleware.js";

const ZA = zoneId("zone-a");
const ZB = zoneId("zone-b");

function makeCtx(metadata: JsonObject = {}): TurnContext {
  return {
    session: {
      agentId: "agent-test",
      sessionId: sessionId("s1"),
      runId: runId("r1"),
      metadata: {},
    },
    turnIndex: 0,
    turnId: `${runId("r1")}-0` as TurnContext["turnId"],
    messages: [],
    metadata,
  };
}

function makeTransport(handler: (method: string) => unknown): NexusTransport {
  const callImpl = async <T>(
    method: string,
    _params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> => {
    const value = handler(method);
    if (value instanceof Error) {
      const err: KoiError = { code: "EXTERNAL", message: value.message, retryable: true };
      return { ok: false, error: err };
    }
    return { ok: true, value: value as T };
  };
  return { call: callImpl, close: () => {} };
}

const localResponse: ToolResponse = { output: "local-result" };
const localHandler: ToolHandler = async () => localResponse;

const baseRequest: ToolRequest = { toolId: "bash", input: { cmd: "ls" } };

describe("createFederationMiddleware", () => {
  test("passes through when no targetZoneId in metadata", async () => {
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map(),
    });
    const result = await mw.wrapToolCall?.(makeCtx({}), baseRequest, localHandler);
    expect(result?.output).toBe("local-result");
  });

  test("passes through when targetZoneId matches localZoneId", async () => {
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map(),
    });
    const result = await mw.wrapToolCall?.(
      makeCtx({ targetZoneId: ZA }),
      baseRequest,
      localHandler,
    );
    expect(result?.output).toBe("local-result");
  });

  test("routes to remote transport when targetZoneId known", async () => {
    const remoteResponse: ToolResponse = { output: "remote-result" };
    let calledMethod: string | undefined;
    const transport = makeTransport((method) => {
      calledMethod = method;
      return remoteResponse;
    });
    const delegated: { zoneId: string; toolId: string }[] = [];
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      onDelegated: (z, req) => delegated.push({ zoneId: z, toolId: req.toolId }),
    });

    const result = await mw.wrapToolCall?.(
      makeCtx({ targetZoneId: ZB }),
      baseRequest,
      localHandler,
    );
    expect(result?.output).toBe("remote-result");
    expect(calledMethod).toBe("federation.zone_execute");
    expect(delegated).toEqual([{ zoneId: "zone-b", toolId: "bash" }]);
  });

  test("throws when targetZoneId is unknown", async () => {
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map(),
    });
    await expect(
      mw.wrapToolCall?.(makeCtx({ targetZoneId: "ghost" }), baseRequest, localHandler),
    ).rejects.toThrow(/unknown target zone "ghost"/);
  });

  test("throws when remote transport returns error result", async () => {
    const transport = makeTransport(() => new Error("network"));
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
    });
    await expect(
      mw.wrapToolCall?.(makeCtx({ targetZoneId: ZB }), baseRequest, localHandler),
    ).rejects.toThrow(/Federation remote call failed/);
  });

  test("describeCapabilities returns fragment when targetZoneId set", () => {
    const mw = createFederationMiddleware({ localZoneId: ZA, remoteTransports: new Map() });
    const fragment = mw.describeCapabilities?.(makeCtx({ targetZoneId: ZB }));
    expect(fragment?.label).toBe("federation");
    expect(fragment?.description).toContain("zone-b");
  });

  test("describeCapabilities returns undefined when no targetZoneId", () => {
    const mw = createFederationMiddleware({ localZoneId: ZA, remoteTransports: new Map() });
    expect(mw.describeCapabilities?.(makeCtx({}))).toBeUndefined();
  });
});
