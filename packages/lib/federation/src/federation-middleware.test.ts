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
import { createStaticZoneHealthMonitor, createZoneRouter } from "./zone-router.js";

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

  test("routes to the nearest healthy zone when no explicit targetZoneId is provided", async () => {
    const nearTransport = makeTransport(() => ({ output: "near" }) as ToolResponse);
    const farTransport = makeTransport(() => ({ output: "far" }) as ToolResponse);
    const router = createZoneRouter({
      monitor: createStaticZoneHealthMonitor([
        { zoneId: zoneId("zone-near"), status: "active", latencyMs: 8 },
        { zoneId: zoneId("zone-far"), status: "active", latencyMs: 50 },
      ]),
    });
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([
        ["zone-near", nearTransport.transport],
        ["zone-far", farTransport.transport],
      ]),
      zoneRouter: router,
    });

    const result = await mw.wrapToolCall?.(makeCtx({}), baseRequest, localHandler);

    expect(result?.output).toBe("near");
    expect(nearTransport.calls).toHaveLength(1);
    expect(farTransport.calls).toHaveLength(0);
  });

  test("does not auto-route when targetZoneId is present but non-string", async () => {
    const remote = makeTransport(() => ({ output: "remote" }) as ToolResponse);
    const router = createZoneRouter({
      monitor: createStaticZoneHealthMonitor([
        { zoneId: zoneId("zone-b"), status: "active", latencyMs: 1 },
      ]),
    });
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", remote.transport]]),
      zoneRouter: router,
    });

    const result = await mw.wrapToolCall?.(
      makeCtx({ targetZoneId: 123 }),
      baseRequest,
      localHandler,
    );

    expect(result?.output).toBe("local-result");
    expect(remote.calls).toHaveLength(0);
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

  test("forwards callId/originZoneId; explicit empty allowlist drops request.metadata", async () => {
    // Regression for #1372 review-loop pass-3: arbitrary
    // request.metadata must NOT cross the federation boundary unless
    // the operator explicitly enumerates keys via
    // forwardedMetadataKeys. An empty Set is a valid explicit choice
    // (drop everything) and prevents tunneling local-only approval
    // flags or trace context that could spoof elevated authority
    // remotely.
    const remoteResponse: ToolResponse = { output: "remote-result" };
    const { transport, calls } = makeTransport(() => remoteResponse);
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      forwardedMetadataKeys: new Set(),
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
    expect(params?.["metadata"]).toBeUndefined();
  });

  test("aborts when request carries metadata but forwardedMetadataKeys was not configured", async () => {
    // Regression for #1372 review-loop pass-3 round 3: silently
    // dropping metadata desynchronizes auth across zones. Force the
    // operator to make an explicit choice when metadata is in play.
    const remoteResponse: ToolResponse = { output: "remote-result" };
    const { transport } = makeTransport(() => remoteResponse);
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      // forwardedMetadataKeys deliberately omitted
    });

    const richRequest: ToolRequest = {
      toolId: "bash",
      input: {},
      metadata: { traceId: "t-1" },
    };

    await expect(
      mw.wrapToolCall?.(makeCtx({ targetZoneId: ZB }), richRequest, localHandler),
    ).rejects.toThrow(/forwardedMetadataKeys/);
  });

  test("forwardedMetadataKeys allowlist sends only listed keys", async () => {
    // Regression for #1372 review-loop pass-3 round 1: opt-in
    // forwarding restricts the metadata bag to an explicit subset.
    const { transport, calls } = makeTransport(() => ({ output: "ok" }) as ToolResponse);
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      forwardedMetadataKeys: new Set(["traceId"]),
    });

    const richRequest: ToolRequest = {
      toolId: "bash",
      input: {},
      metadata: { reason: "secret", traceId: "t-1", approval: "pre-approved" },
    };

    await mw.wrapToolCall?.(makeCtx({ targetZoneId: ZB }), richRequest, localHandler);

    const params = calls.filter((c) => c.method === "federation.zone_execute")[0]?.params;
    expect(params?.["metadata"]).toEqual({ traceId: "t-1" });
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

  test("forwards session/turn principal when principalPolicy=forward", async () => {
    // Regression for #1372 review-loop pass-2 rounds 1-3: cross-zone
    // execution forwards a principal envelope ONLY when the remote is
    // explicitly opted-in via remoteCapabilities[zone].principalPolicy
    // = "forward". This guards against principal spoofing on
    // unauthenticated transports.
    const recorded: Record<string, unknown>[] = [];
    const callImpl = async <T>(
      _method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      recorded.push(params);
      return { ok: true, value: { output: "ok" } as T };
    };
    const transport: NexusTransport = { call: callImpl, close: () => {} };
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      remoteCapabilities: new Map([["zone-b", { understandsPrincipalFields: true }]]),
      principalForwarding: new Map([["zone-b", "forward"]]),
      tenantIdResolver: (c) => {
        const t = (c.session.metadata as { tenant?: string } | undefined)?.tenant;
        return typeof t === "string" ? t : undefined;
      },
    });

    const ctx: TurnContext = {
      session: {
        agentId: "agent-x",
        sessionId: sessionId("s-99"),
        runId: runId("r-99"),
        conversationId: "conv-1",
        userId: "alice",
        channelId: "@koi/channel-telegram",
        metadata: { tenant: "acme" },
      },
      turnIndex: 3,
      turnId: `${runId("r-99")}-3` as TurnContext["turnId"],
      messages: [],
      metadata: { targetZoneId: ZB, traceId: "trace-1" },
    };

    await mw.wrapToolCall?.(ctx, { toolId: "bash", input: {} }, localHandler);

    const exec = recorded[0];
    expect(exec).toBeDefined();
    expect(exec?.["principalPolicy"]).toBe("forward");
    const principal = exec?.["principal"] as Record<string, unknown> | undefined;
    expect(principal).toBeDefined();
    expect(principal?.["agentId"]).toBe("agent-x");
    expect(principal?.["sessionId"]).toBe("s-99");
    expect(principal?.["runId"]).toBe("r-99");
    expect(principal?.["conversationId"]).toBe("conv-1");
    expect(principal?.["userId"]).toBe("alice");
    expect(principal?.["channelId"]).toBe("@koi/channel-telegram");
    expect(principal?.["turnIndex"]).toBe(3);
    expect(principal?.["turnId"]).toBe("r-99-3");
    // Allowlist: session.metadata and ctx.metadata are NOT forwarded
    // (review-loop pass-2 round 6 — they may carry trace context,
    // tenant hints, or credentials accidentally stored in metadata).
    expect(principal?.["sessionMetadata"]).toBeUndefined();
    expect(principal?.["turnMetadata"]).toBeUndefined();
    // tenantId claim is required and explicit (review-loop pass-2 round 9).
    expect(principal?.["tenantId"]).toBe("acme");
  });

  test("rejects construction when principalForwarding=forward but no tenantIdResolver is provided", () => {
    // Regression for #1372 review-loop pass-2 round 9: forwarding the
    // local principal without a tenant claim collapses tenant isolation
    // — the remote authorizes by agent/session ids that may collide
    // across tenants. Construction must fail-fast unless an explicit
    // tenantIdResolver is supplied.
    const transport: NexusTransport = { call: async () => ({}) as never, close: () => {} };
    expect(() =>
      createFederationMiddleware({
        localZoneId: ZA,
        remoteTransports: new Map([["zone-b", transport]]),
        remoteCapabilities: new Map([["zone-b", { understandsPrincipalFields: true }]]),
        principalForwarding: new Map([["zone-b", "forward"]]),
        // No tenantIdResolver → must throw.
      }),
    ).toThrow(/tenantIdResolver/);
  });

  test("aborts the call when tenantIdResolver returns no tenant for a forward zone", async () => {
    // Regression for #1372 review-loop pass-2 round 9: even with a
    // resolver configured, an empty/undefined tenant for THIS request
    // means the operator cannot scope the principal — fail closed
    // rather than forward an unscoped envelope.
    const callImpl = async <T>(): Promise<Result<T, KoiError>> => {
      throw new Error("transport must not be invoked");
    };
    const transport: NexusTransport = { call: callImpl, close: () => {} };
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      remoteCapabilities: new Map([["zone-b", { understandsPrincipalFields: true }]]),
      principalForwarding: new Map([["zone-b", "forward"]]),
      tenantIdResolver: () => undefined,
    });

    await expect(
      mw.wrapToolCall?.(makeCtx({ targetZoneId: ZB }), baseRequest, localHandler),
    ).rejects.toThrow(/tenantIdResolver returned no tenantId/);
  });

  test("default zone_execute payload is legacy v1 shape (no principalPolicy, no principal)", async () => {
    // Regression for #1372 review-loop pass-2 rounds 3 & 5: principal
    // forwarding is opt-in. With no capability advertised, the wire
    // payload must be the exact legacy v1 shape so older receivers
    // that strict-validate request shape can still accept the call.
    const recorded: Record<string, unknown>[] = [];
    const callImpl = async <T>(
      _method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      recorded.push(params);
      return { ok: true, value: { output: "ok" } as T };
    };
    const transport: NexusTransport = { call: callImpl, close: () => {} };
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      // No remoteCapabilities → no new fields on the wire
    });

    await mw.wrapToolCall?.(makeCtx({ targetZoneId: ZB }), baseRequest, localHandler);

    const exec = recorded[0];
    expect(exec).toBeDefined();
    expect(exec?.["principalPolicy"]).toBeUndefined();
    expect(exec?.["principal"]).toBeUndefined();
    // Sanity: legacy correlation tuple is still present.
    expect(exec?.["protocolVersion"]).toBe(1);
    expect(exec?.["callId"]).toBeDefined();
    expect(exec?.["originZoneId"]).toBe(ZA);
  });

  test("when remote advertises understandsPrincipalFields, policy=omit is sent (no principal envelope)", async () => {
    const recorded: Record<string, unknown>[] = [];
    const callImpl = async <T>(
      _method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      recorded.push(params);
      return { ok: true, value: { output: "ok" } as T };
    };
    const transport: NexusTransport = { call: callImpl, close: () => {} };
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      remoteCapabilities: new Map([["zone-b", { understandsPrincipalFields: true }]]),
      // No principalForwarding entry → defaults to "omit"
    });

    await mw.wrapToolCall?.(makeCtx({ targetZoneId: ZB }), baseRequest, localHandler);

    expect(recorded[0]?.["principalPolicy"]).toBe("omit");
    expect(recorded[0]?.["principal"]).toBeUndefined();
  });

  test("rejects construction when principalForwarding=forward but remote did not advertise support", () => {
    // Regression for #1372 review-loop pass-2 round 8: enabling
    // forwarding for a peer that hasn't advertised
    // understandsPrincipalFields would silently break delegated calls
    // against legacy strict receivers. Fail-fast at construction.
    const transport: NexusTransport = { call: async () => ({}) as never, close: () => {} };
    expect(() =>
      createFederationMiddleware({
        localZoneId: ZA,
        remoteTransports: new Map([["zone-b", transport]]),
        principalForwarding: new Map([["zone-b", "forward"]]),
        // No remoteCapabilities → not advertised → must throw.
      }),
    ).toThrow(/has not advertised understandsPrincipalFields/);
  });

  test("remote-advertised capability alone does NOT release principal — local principalForwarding is required", async () => {
    // Regression for #1372 review-loop pass-2 round 7: a peer that
    // advertises understandsPrincipalFields must NOT receive identity
    // unless principalForwarding explicitly trusts it.
    const recorded: Record<string, unknown>[] = [];
    const callImpl = async <T>(
      _method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      recorded.push(params);
      return { ok: true, value: { output: "ok" } as T };
    };
    const transport: NexusTransport = { call: callImpl, close: () => {} };
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      // Peer claims it can handle principal fields...
      remoteCapabilities: new Map([["zone-b", { understandsPrincipalFields: true }]]),
      // ...but operator has NOT trusted it for identity release.
    });

    await mw.wrapToolCall?.(makeCtx({ targetZoneId: ZB }), baseRequest, localHandler);

    expect(recorded[0]?.["principal"]).toBeUndefined();
    expect(recorded[0]?.["principalPolicy"]).toBe("omit");
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

  test("abort listener is removed after a successful remote call (no zone_cancel on later abort)", async () => {
    // Regression for gap item 17: a successful call must remove its abort
    // listener in the finally block. If the caller later aborts the (now
    // unrelated) controller, the middleware must NOT emit a stray
    // federation.zone_cancel — that would target a callId the remote has
    // already completed and forgotten.
    const { transport, calls } = makeTransport((method) => {
      if (method === "federation.zone_execute") return { output: "ok" } satisfies ToolResponse;
      return { ok: true };
    });
    const mw = createFederationMiddleware({
      localZoneId: ZA,
      remoteTransports: new Map([["zone-b", transport]]),
      remoteCapabilities: cancelCapableForB,
    });

    const controller = new AbortController();
    const result = await mw.wrapToolCall?.(
      makeCtx({ targetZoneId: ZB }),
      { toolId: "bash", input: {}, callId: "call-clean", signal: controller.signal },
      localHandler,
    );
    expect(result?.output).toBe("ok");

    // Now abort AFTER the call settled. If the listener leaked, this
    // would synchronously fire onAbort → sendCancel → a second RPC.
    controller.abort();
    await new Promise((r) => setTimeout(r, 5));

    expect(calls.filter((c) => c.method === "federation.zone_cancel")).toEqual([]);
  });
});
