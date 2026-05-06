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

function makeTransport(handler: (method: string) => unknown): {
  transport: NexusTransport;
  calls: { method: string; params: Record<string, unknown> }[];
} {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const callImpl = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> => {
    calls.push({ method, params });
    const value = handler(method);
    if (value instanceof Error) {
      const err: KoiError = { code: "EXTERNAL", message: value.message, retryable: true };
      return { ok: false, error: err };
    }
    return { ok: true, value: value as T };
  };
  return { transport: { call: callImpl, close: () => {} }, calls };
}

const localResponse: ToolResponse = { output: "local-result" };
const localHandler: ToolHandler = async () => localResponse;

const baseRequest: ToolRequest = { toolId: "bash", input: { cmd: "ls" } };

/** Capability map advertising cancel support on zone-b. */
const cancelCapableForB: ReadonlyMap<string, { readonly cancel: boolean }> = new Map([
  ["zone-b", { cancel: true }],
]);

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
    const { transport } = makeTransport((method) => {
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
    const { transport } = makeTransport(() => new Error("network"));
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

  test("forwards metadata, callId, and originZoneId to remote zone_execute", async () => {
    // Regression for #1372 review-loop: delegated calls must preserve the
    // full invocation envelope so the remote zone can enforce the same
    // policy/approval semantics as the local path.
    const remoteResponse: ToolResponse = { output: "remote-result" };
    const { transport, calls } = makeTransport(() => remoteResponse);
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
    });

    const richRequest: ToolRequest = {
      toolId: "bash",
      input: { cmd: "ls" },
      metadata: { reason: "investigation", traceId: "t-1" },
      callId: "call-42",
    };

    await mw.wrapToolCall?.(makeCtx({ targetZoneId: ZB }), richRequest, localHandler);

    const executeCalls = calls.filter((c) => c.method === "federation.zone_execute");
    expect(executeCalls).toHaveLength(1);
    const params = executeCalls[0]?.params;
    expect(params?.["toolId"]).toBe("bash");
    expect(params?.["callId"]).toBe("call-42");
    expect(params?.["originZoneId"]).toBe(ZA);
    expect(params?.["targetZoneId"]).toBe(ZB);
    expect(params?.["metadata"]).toEqual({ reason: "investigation", traceId: "t-1" });
  });

  test("bridges caller AbortSignal as federation.zone_cancel on remote", async () => {
    // Regression for #1372 review-loop: caller cancellation must propagate
    // to the remote zone so federated work can stop, not become orphaned.
    let resolveExecute: ((v: ToolResponse) => void) | undefined;
    const cancellations: string[] = [];
    const callImpl = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      if (method === "federation.zone_cancel") {
        cancellations.push(String(params["callId"]));
        return { ok: true, value: undefined as T };
      }
      // zone_execute: hold open until the test cancels.
      const response = await new Promise<ToolResponse>((res) => {
        resolveExecute = res;
      });
      return { ok: true, value: response as T };
    };
    const transport: NexusTransport = { call: callImpl, close: () => {} };
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      remoteCapabilities: cancelCapableForB,
    });

    const controller = new AbortController();
    const richRequest: ToolRequest = {
      toolId: "bash",
      input: {},
      callId: "call-99",
      signal: controller.signal,
    };

    const pending = mw.wrapToolCall?.(makeCtx({ targetZoneId: ZB }), richRequest, localHandler);

    // Cancel the caller; expect both a federation.zone_cancel for callId
    // AND immediate rejection of the awaited call (so abort actually
    // unblocks the caller even if the remote ignores cancel).
    controller.abort();

    await expect(pending).rejects.toThrow(/aborted; remote outcome indeterminate/);
    expect(cancellations).toEqual(["call-99"]);

    // Drain the held remote promise so it doesn't leak.
    resolveExecute?.({ output: "late" });
  });

  test("synthesizes a federation callId when caller omits one; abort cancels via synthetic id", async () => {
    // Regression for #1372 review-loop round 3: without a callId, abort
    // would reject the caller while the remote tool kept running with no
    // way to cancel. The middleware must always forward a callId so the
    // remote has a correlation handle.
    const cancellations: string[] = [];
    let resolveExecute: ((v: ToolResponse) => void) | undefined;
    let executedCallId: unknown;

    const callImpl = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      if (method === "federation.zone_cancel") {
        cancellations.push(String(params["callId"]));
        return { ok: true, value: undefined as T };
      }
      executedCallId = params["callId"];
      const response = await new Promise<ToolResponse>((res) => {
        resolveExecute = res;
      });
      return { ok: true, value: response as T };
    };
    const transport: NexusTransport = { call: callImpl, close: () => {} };
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      remoteCapabilities: cancelCapableForB,
    });

    const controller = new AbortController();
    const requestNoCallId: ToolRequest = {
      toolId: "bash",
      input: {},
      signal: controller.signal,
      // NO callId
    };

    const pending = mw.wrapToolCall?.(makeCtx({ targetZoneId: ZB }), requestNoCallId, localHandler);

    controller.abort();
    await expect(pending).rejects.toThrow(/aborted; remote outcome indeterminate/);

    // Cancel must have been issued — and the executed callId must match
    // the one the cancel targeted (so the remote can correlate them).
    expect(cancellations).toHaveLength(1);
    expect(typeof executedCallId).toBe("string");
    expect(cancellations[0]).toBe(String(executedCallId));
    expect(String(executedCallId)).toMatch(/^fed-/);

    resolveExecute?.({ output: "late" });
  });

  test("abort error carries structured kind and indeterminate-outcome message", async () => {
    // Regression for #1372 review-loop round 4: abort surfaces an
    // outcome-indeterminate signal (not a clean failure) so callers know
    // not to retry non-idempotent operations without an idempotency key.
    const transport: NexusTransport = {
      call: async () => new Promise(() => {}), // never settles
      close: () => {},
    };
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
    });

    const controller = new AbortController();
    const pending = mw.wrapToolCall?.(
      makeCtx({ targetZoneId: ZB }),
      { toolId: "bash", input: {}, callId: "call-x", signal: controller.signal },
      localHandler,
    );

    controller.abort();

    let caught: unknown;
    try {
      await pending;
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { kind?: string; targetZoneId?: string; callId?: string };
    expect(err.kind).toBe("federation_abort_indeterminate");
    expect(err.targetZoneId).toBe(ZB);
    expect(err.callId).toBe("call-x");
    expect(err.message).toMatch(/outcome indeterminate/);
    expect(err.message).toMatch(/idempotency/);
  });

  test("zone_execute and zone_cancel both carry protocolVersion + full correlation tuple", async () => {
    // Regression for #1372 review-loop round 6: cancel must not key on
    // callId alone; the remote correlates by the same tuple as execute,
    // including originZoneId, toolId, and the wire-protocol version.
    const recorded: { method: string; params: Record<string, unknown> }[] = [];
    let resolveExecute: ((v: ToolResponse) => void) | undefined;
    const callImpl = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      recorded.push({ method, params });
      if (method === "federation.zone_cancel") {
        return { ok: true, value: undefined as T };
      }
      const response = await new Promise<ToolResponse>((res) => {
        resolveExecute = res;
      });
      return { ok: true, value: response as T };
    };
    const transport: NexusTransport = { call: callImpl, close: () => {} };
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      remoteCapabilities: cancelCapableForB,
    });

    const controller = new AbortController();
    const pending = mw.wrapToolCall?.(
      makeCtx({ targetZoneId: ZB }),
      { toolId: "bash", input: {}, callId: "call-tuple", signal: controller.signal },
      localHandler,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();

    const exec = recorded.find((c) => c.method === "federation.zone_execute");
    const cancel = recorded.find((c) => c.method === "federation.zone_cancel");

    expect(exec?.params["protocolVersion"]).toBe(1);
    expect(exec?.params["originZoneId"]).toBe(ZA);
    expect(exec?.params["targetZoneId"]).toBe(ZB);
    expect(exec?.params["callId"]).toBe("call-tuple");

    expect(cancel?.params["protocolVersion"]).toBe(1);
    expect(cancel?.params["callId"]).toBe("call-tuple");
    expect(cancel?.params["targetZoneId"]).toBe(ZB);
    expect(cancel?.params["originZoneId"]).toBe(ZA);
    expect(cancel?.params["toolId"]).toBe("bash");

    resolveExecute?.({ output: "late" });
  });

  test("when remote does NOT advertise cancel capability, abort still rejects but no cancel RPC is sent", async () => {
    // Regression for #1372 review-loop round 8: dispatching zone_cancel
    // to a peer with no receiver would falsely tell the caller "cancelled"
    // while remote work continues. Without an advertised capability, the
    // middleware skips the cancel RPC and surfaces an explicit
    // unsupported-cancel message in the error.
    const recorded: string[] = [];
    let resolveExecute: ((v: ToolResponse) => void) | undefined;
    const callImpl = async <T>(
      method: string,
      _params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      recorded.push(method);
      if (method === "federation.zone_cancel") {
        return { ok: true, value: undefined as T };
      }
      const response = await new Promise<ToolResponse>((res) => {
        resolveExecute = res;
      });
      return { ok: true, value: response as T };
    };
    const transport: NexusTransport = { call: callImpl, close: () => {} };
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      // No remoteCapabilities → cancel disabled by default.
    });

    const controller = new AbortController();
    const pending = mw.wrapToolCall?.(
      makeCtx({ targetZoneId: ZB }),
      { toolId: "bash", input: {}, callId: "call-no-cap", signal: controller.signal },
      localHandler,
    );
    controller.abort();

    let caught: unknown;
    try {
      await pending;
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/has NOT advertised cancel support/);
    expect(recorded).toEqual(["federation.zone_execute"]);

    resolveExecute?.({ output: "late" });
  });

  test("does not lose abort that fires synchronously between dispatch setup steps", async () => {
    // Regression for #1372 review-loop round 5: an abort that flips
    // synchronously after listener registration but before await must
    // still trigger cancel + reject (closes listener-registration race).
    let resolveExecute: ((v: ToolResponse) => void) | undefined;
    const cancellations: string[] = [];
    const callImpl = async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      if (method === "federation.zone_cancel") {
        cancellations.push(String(params["callId"]));
        return { ok: true, value: undefined as T };
      }
      // Abort synchronously *during* dispatch — before await.
      controller.abort();
      const response = await new Promise<ToolResponse>((res) => {
        resolveExecute = res;
      });
      return { ok: true, value: response as T };
    };
    const transport: NexusTransport = { call: callImpl, close: () => {} };
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      remoteCapabilities: cancelCapableForB,
    });

    const controller = new AbortController();
    const richRequest: ToolRequest = {
      toolId: "bash",
      input: {},
      callId: "call-race",
      signal: controller.signal,
    };

    await expect(
      mw.wrapToolCall?.(makeCtx({ targetZoneId: ZB }), richRequest, localHandler),
    ).rejects.toThrow(/outcome indeterminate/);
    expect(cancellations).toEqual(["call-race"]);

    resolveExecute?.({ output: "late" });
  });

  test("rejects immediately when signal is already aborted (no remote dispatch)", async () => {
    // Regression for #1372 review-loop: a pre-aborted request must not
    // trigger any federation.zone_execute call (no side effects after
    // the caller has given up).
    const { transport, calls } = makeTransport(() => ({ output: "should-not-run" }));
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
    });

    const controller = new AbortController();
    controller.abort();

    const richRequest: ToolRequest = {
      toolId: "bash",
      input: {},
      callId: "call-pre",
      signal: controller.signal,
    };

    await expect(
      mw.wrapToolCall?.(makeCtx({ targetZoneId: ZB }), richRequest, localHandler),
    ).rejects.toThrow(/aborted; remote outcome indeterminate/);

    expect(calls).toEqual([]);
  });
});
