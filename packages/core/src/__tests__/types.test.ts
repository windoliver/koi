import { describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentManifest,
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  DelegationComponent,
  DelegationConfig,
  DelegationDenyReason,
  DelegationGrant,
  DelegationId,
  DelegationScope,
  DelegationVerifyResult,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineStopReason,
  GovernanceUsage,
  KoiError,
  KoiErrorCode,
  KoiMiddleware,
  PermissionConfig,
  ProcessId,
  Resolver,
  Result,
  RevocationRegistry,
  ScopeChecker,
  SpawnCheck,
  SubsystemToken,
  Tool,
  ToolDescriptor,
  TrustTier,
} from "../index.js";
import { agentId, CREDENTIALS, DELEGATION, EVENTS, GOVERNANCE, MEMORY, token } from "../index.js";

/**
 * Type-level tests using @ts-expect-error.
 * Each assertion verifies that a type constraint is enforced at compile time.
 */

describe("Result<T, E> narrowing", () => {
  test("narrows to value on ok: true", () => {
    const result: Result<number> = { ok: true, value: 42 };
    if (result.ok) {
      const v: number = result.value;
      expect(v).toBe(42);
    }
  });

  test("narrows to error on ok: false", () => {
    const result: Result<number> = {
      ok: false,
      error: { code: "NOT_FOUND", message: "missing", retryable: false },
    };
    if (!result.ok) {
      const e: KoiError = result.error;
      expect(e.code).toBe("NOT_FOUND");
    }
  });

  test("value is not accessible when ok is false", () => {
    const result: Result<number> = {
      ok: false,
      error: { code: "INTERNAL", message: "fail", retryable: false },
    };
    if (!result.ok) {
      // @ts-expect-error — value does not exist on error branch
      const _v: number = result.value;
      void _v;
    }
  });

  test("error is not accessible when ok is true", () => {
    const result: Result<number> = { ok: true, value: 1 };
    if (result.ok) {
      // @ts-expect-error — error does not exist on success branch
      const _e: KoiError = result.error;
      void _e;
    }
  });
});

describe("ContentBlock discriminant", () => {
  test("narrows to TextBlock on kind: text", () => {
    const block: ContentBlock = { kind: "text", text: "hello" };
    if (block.kind === "text") {
      const t: string = block.text;
      expect(t).toBe("hello");
    }
  });

  test("narrows to FileBlock on kind: file", () => {
    const block: ContentBlock = {
      kind: "file",
      url: "https://x.com/f",
      mimeType: "text/plain",
    };
    if (block.kind === "file") {
      const url: string = block.url;
      expect(url).toContain("x.com");
    }
  });

  test("narrows to CustomBlock on kind: custom", () => {
    const block: ContentBlock = { kind: "custom", type: "card", data: {} };
    if (block.kind === "custom") {
      const t: string = block.type;
      expect(t).toBe("card");
    }
  });

  test("text property not accessible on file block", () => {
    const block: ContentBlock = {
      kind: "file",
      url: "https://x.com/f",
      mimeType: "text/plain",
    };
    if (block.kind === "file") {
      // @ts-expect-error — text does not exist on FileBlock
      const _t: string = block.text;
      void _t;
    }
  });
});

describe("EngineEvent discriminant", () => {
  test("narrows to text_delta", () => {
    const event: EngineEvent = { kind: "text_delta", delta: "hi" };
    if (event.kind === "text_delta") {
      const d: string = event.delta;
      expect(d).toBe("hi");
    }
  });

  test("narrows to tool_call_start with toolName, callId, and args", () => {
    const event: EngineEvent = {
      kind: "tool_call_start",
      toolName: "calc",
      callId: "c1",
      args: { x: 1, y: 2 },
    };
    if (event.kind === "tool_call_start") {
      expect(event.toolName).toBe("calc");
      expect(event.callId).toBe("c1");
      expect(event.args).toEqual({ x: 1, y: 2 });
    }
  });

  test("narrows to tool_call_end with callId and result", () => {
    const event: EngineEvent = { kind: "tool_call_end", callId: "c1", result: 42 };
    if (event.kind === "tool_call_end") {
      expect(event.callId).toBe("c1");
      expect(event.result).toBe(42);
    }
  });

  test("narrows to done with EngineOutput", () => {
    const event: EngineEvent = {
      kind: "done",
      output: {
        content: [],
        stopReason: "completed",
        metrics: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          turns: 0,
          durationMs: 0,
        },
      },
    };
    if (event.kind === "done") {
      expect(event.output.stopReason).toBe("completed");
    }
  });
});

describe("EngineInput discriminant", () => {
  test("narrows to text input", () => {
    const input: EngineInput = { kind: "text", text: "hello" };
    if (input.kind === "text") {
      expect(input.text).toBe("hello");
    }
  });

  test("narrows to messages input", () => {
    const input: EngineInput = { kind: "messages", messages: [] };
    if (input.kind === "messages") {
      expect(input.messages).toEqual([]);
    }
  });
});

describe("EngineStopReason", () => {
  test("accepts valid literals", () => {
    const reasons: readonly EngineStopReason[] = ["completed", "max_turns", "interrupted", "error"];
    expect(reasons).toHaveLength(4);
  });
});

describe("SubsystemToken branding", () => {
  test("tokens with different types are strings at runtime", () => {
    const a: string = token<{ readonly x: number }>("shared");
    const b: string = token<{ readonly y: string }>("shared");
    // At runtime they are equal (same string) but type-level they are incompatible
    expect(a).toBe(b);
  });

  test("branded tokens cannot be assigned across types", () => {
    const _a: SubsystemToken<{ readonly x: number }> = token<{ readonly x: number }>("t");
    // @ts-expect-error — SubsystemToken<{x}> is not assignable to SubsystemToken<{y}>
    const _b: SubsystemToken<{ readonly y: string }> = _a;
    void _b;
  });
});

describe("readonly enforcement", () => {
  test("Result properties are readonly", () => {
    const result: Result<number> = { ok: true, value: 42 };
    // @ts-expect-error — cannot assign to readonly property
    result.ok = false;
  });

  test("ContentBlock properties are readonly", () => {
    const block: ContentBlock = { kind: "text", text: "hi" };
    // @ts-expect-error — cannot assign to readonly property
    block.kind = "file";
  });

  test("ProcessId properties are readonly", () => {
    const pid: ProcessId = { id: agentId("1"), name: "test", type: "copilot", depth: 0 };
    // @ts-expect-error — cannot assign to readonly property
    pid.id = agentId("2");
  });

  test("ProcessId.id requires AgentId branded type", () => {
    // @ts-expect-error — string is not assignable to AgentId
    const _pid: ProcessId = { id: "plain-string", name: "test", type: "copilot", depth: 0 };
    void _pid;
  });

  test("ToolDescriptor properties are readonly", () => {
    const td: ToolDescriptor = { name: "calc", description: "Calculator", inputSchema: {} };
    // @ts-expect-error — cannot assign to readonly property
    td.name = "other";
  });

  test("AgentManifest properties are readonly", () => {
    const m: AgentManifest = { name: "test", version: "0.0.0", model: { name: "gpt-4" } };
    // @ts-expect-error — cannot assign to readonly property
    m.name = "other";
  });
});

describe("Agent component typing", () => {
  test("component returns T | undefined for typed token", () => {
    const agentLike: Pick<Agent, "component"> = {
      component: <T>(_token: SubsystemToken<T>): T | undefined => undefined,
    };
    const result = agentLike.component(token<{ readonly val: number }>("test"));
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Well-known token type narrowing
// ---------------------------------------------------------------------------

describe("well-known token type narrowing", () => {
  test("MEMORY token narrows component to MemoryComponent", () => {
    const agentLike: Pick<Agent, "component"> = {
      component: <T>(_token: SubsystemToken<T>): T | undefined => undefined,
    };
    const mem = agentLike.component(MEMORY);
    if (mem) {
      const _: Promise<readonly unknown[]> = mem.recall("test");
      void _;
    }
    expect(mem).toBeUndefined();
  });

  test("GOVERNANCE token narrows component to GovernanceComponent", () => {
    const agentLike: Pick<Agent, "component"> = {
      component: <T>(_token: SubsystemToken<T>): T | undefined => undefined,
    };
    const gov = agentLike.component(GOVERNANCE);
    if (gov) {
      const _usage: GovernanceUsage = gov.usage();
      const _check: SpawnCheck = gov.checkSpawn(0);
      void _usage;
      void _check;
    }
    expect(gov).toBeUndefined();
  });

  test("CREDENTIALS token narrows component to CredentialComponent", () => {
    const agentLike: Pick<Agent, "component"> = {
      component: <T>(_token: SubsystemToken<T>): T | undefined => undefined,
    };
    const cred = agentLike.component(CREDENTIALS);
    if (cred) {
      const _: Promise<string | undefined> = cred.get("api_key");
      void _;
    }
    expect(cred).toBeUndefined();
  });

  test("EVENTS token narrows component to EventComponent", () => {
    const agentLike: Pick<Agent, "component"> = {
      component: <T>(_token: SubsystemToken<T>): T | undefined => undefined,
    };
    const events = agentLike.component(EVENTS);
    if (events) {
      const _: Promise<void> = events.emit("test", {});
      void _;
    }
    expect(events).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Negative type tests for all 6 contracts
// ---------------------------------------------------------------------------

describe("AgentManifest negative types", () => {
  test("model is required", () => {
    // @ts-expect-error — model is required on AgentManifest
    const _m: AgentManifest = { name: "test", version: "0.0.0" };
    void _m;
  });

  test("name is required", () => {
    // @ts-expect-error — name is required on AgentManifest
    const _m: AgentManifest = { version: "0.0.0", model: { name: "gpt-4" } };
    void _m;
  });
});

describe("ChannelAdapter negative types", () => {
  test("capabilities is required", () => {
    // @ts-expect-error — capabilities is required on ChannelAdapter
    const _c: ChannelAdapter = {
      name: "test",
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
      onMessage: () => () => {},
    };
    void _c;
  });

  test("send is required", () => {
    const caps: ChannelCapabilities = {
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: false,
    };
    // @ts-expect-error — send is required on ChannelAdapter
    const _c: ChannelAdapter = {
      name: "test",
      capabilities: caps,
      connect: async () => {},
      disconnect: async () => {},
      onMessage: () => () => {},
    };
    void _c;
  });
});

describe("KoiMiddleware negative types", () => {
  test("name-only middleware satisfies interface", () => {
    const mw: KoiMiddleware = { name: "passthrough" };
    expect(mw.name).toBe("passthrough");
  });

  test("name is required", () => {
    // @ts-expect-error — name is required on KoiMiddleware
    const _mw: KoiMiddleware = {};
    void _mw;
  });

  test("middleware with session hooks is valid", () => {
    const mw: KoiMiddleware = {
      name: "session-only",
      onSessionStart: async () => {},
      onSessionEnd: async () => {},
    };
    expect(mw.name).toBe("session-only");
  });

  test("priority is optional", () => {
    const mw: KoiMiddleware = { name: "no-priority" };
    expect(mw.priority).toBeUndefined();
  });

  test("priority accepts a number", () => {
    const mw: KoiMiddleware = { name: "with-priority", priority: 100 };
    expect(mw.priority).toBe(100);
  });

  test("priority is readonly", () => {
    const mw: KoiMiddleware = { name: "readonly-priority", priority: 200 };
    // @ts-expect-error — cannot assign to readonly property
    mw.priority = 300;
  });
});

describe("EngineAdapter negative types", () => {
  test("stream is required", () => {
    // @ts-expect-error — stream is required on EngineAdapter
    const _e: EngineAdapter = { engineId: "test" };
    void _e;
  });

  test("engineId is required", () => {
    async function* fakeStream(): AsyncGenerator<EngineEvent> {
      yield {
        kind: "done",
        output: {
          content: [],
          stopReason: "completed",
          metrics: {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            turns: 0,
            durationMs: 0,
          },
        },
      };
    }
    // @ts-expect-error — engineId is required on EngineAdapter
    const _e: EngineAdapter = { stream: fakeStream };
    void _e;
  });

  test("dispose and saveState are optional", () => {
    async function* fakeStream(): AsyncGenerator<EngineEvent> {
      yield {
        kind: "done",
        output: {
          content: [],
          stopReason: "completed",
          metrics: {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            turns: 0,
            durationMs: 0,
          },
        },
      };
    }
    const e: EngineAdapter = { engineId: "test", stream: fakeStream };
    expect(e.engineId).toBe("test");
  });
});

describe("KoiError negative types", () => {
  test("retryable is required", () => {
    // @ts-expect-error — retryable is required on KoiError
    const _e: KoiError = { code: "INTERNAL", message: "fail" };
    void _e;
  });

  test("code must be valid KoiErrorCode", () => {
    const _e: KoiError = {
      // @ts-expect-error — "UNKNOWN" is not a valid KoiErrorCode
      code: "UNKNOWN",
      message: "fail",
      retryable: false,
    };
    void _e;
  });
});

describe("PermissionConfig negative types", () => {
  test("non-string arrays are rejected", () => {
    // @ts-expect-error — number[] is not assignable to readonly string[]
    const _p: PermissionConfig = { allow: [1, 2, 3] };
    void _p;
  });
});

// ---------------------------------------------------------------------------
// TrustTier and SpawnCheck
// ---------------------------------------------------------------------------

describe("TrustTier", () => {
  test("accepts valid trust tier literals", () => {
    const tiers: readonly TrustTier[] = ["sandbox", "verified", "promoted"];
    expect(tiers).toHaveLength(3);
  });
});

describe("SpawnCheck discriminant", () => {
  test("narrows to allowed branch", () => {
    const check: SpawnCheck = { allowed: true };
    if (check.allowed) {
      expect(check.allowed).toBe(true);
    }
  });

  test("narrows to denied branch with reason", () => {
    const check: SpawnCheck = { allowed: false, reason: "max depth exceeded" };
    if (!check.allowed) {
      expect(check.reason).toBe("max depth exceeded");
    }
  });
});

// ---------------------------------------------------------------------------
// KoiErrorCode and KoiError extended fields
// ---------------------------------------------------------------------------

describe("KoiErrorCode", () => {
  test("accepts all 8 valid error codes", () => {
    const codes: readonly KoiErrorCode[] = [
      "VALIDATION",
      "NOT_FOUND",
      "PERMISSION",
      "CONFLICT",
      "RATE_LIMIT",
      "TIMEOUT",
      "EXTERNAL",
      "INTERNAL",
    ];
    expect(codes).toHaveLength(8);
  });

  test("rejects invalid error codes", () => {
    // @ts-expect-error — "UNKNOWN" is not a valid KoiErrorCode
    const _invalid: KoiErrorCode = "UNKNOWN";
    void _invalid;
  });
});

describe("KoiError new fields", () => {
  test("context is optional and accepts JsonObject", () => {
    const withContext: KoiError = {
      code: "NOT_FOUND",
      message: "missing",
      retryable: false,
      context: { resourceId: "abc-123" },
    };
    expect(withContext.context).toEqual({ resourceId: "abc-123" });
  });

  test("retryAfterMs is optional and accepts number", () => {
    const withRetry: KoiError = {
      code: "RATE_LIMIT",
      message: "too fast",
      retryable: true,
      retryAfterMs: 5000,
    };
    expect(withRetry.retryAfterMs).toBe(5000);
  });

  test("KoiError without new fields is still valid", () => {
    const minimal: KoiError = {
      code: "INTERNAL",
      message: "fail",
      retryable: false,
    };
    expect(minimal.context).toBeUndefined();
    expect(minimal.retryAfterMs).toBeUndefined();
  });

  test("context is readonly", () => {
    const err: KoiError = {
      code: "VALIDATION",
      message: "bad",
      retryable: false,
      context: { field: "email" },
    };
    // @ts-expect-error — cannot assign to readonly property
    err.context = {};
  });

  test("retryAfterMs is readonly", () => {
    const err: KoiError = {
      code: "TIMEOUT",
      message: "slow",
      retryable: true,
      retryAfterMs: 1000,
    };
    // @ts-expect-error — cannot assign to readonly property
    err.retryAfterMs = 2000;
  });
});

describe("Result with custom error type", () => {
  test("narrows with string error type", () => {
    const result: Result<number, string> = { ok: false, error: "boom" };
    if (!result.ok) {
      const e: string = result.error;
      expect(e).toBe("boom");
    }
  });

  test("narrows with custom error object", () => {
    type CustomError = { readonly kind: string; readonly detail: string };
    const result: Result<number, CustomError> = {
      ok: false,
      error: { kind: "auth", detail: "expired token" },
    };
    if (!result.ok) {
      expect(result.error.kind).toBe("auth");
    }
  });
});

// ---------------------------------------------------------------------------
// Resolver type tests
// ---------------------------------------------------------------------------

describe("Resolver type tests", () => {
  test("generic instantiation compiles", () => {
    type ToolMeta = { readonly name: string };
    const _r: Resolver<ToolMeta, Tool> = {
      discover: async () => [],
      load: async () => ({
        ok: true,
        value: {
          descriptor: { name: "t", description: "d", inputSchema: {} },
          trustTier: "sandbox",
          execute: async () => ({}),
        },
      }),
    };
    expect(_r.discover).toBeDefined();
  });

  test("load returns Result<TFull, KoiError>", async () => {
    type ToolMeta = { readonly name: string };
    const r: Resolver<ToolMeta, Tool> = {
      discover: async () => [],
      load: async () => ({
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "missing",
          retryable: false,
        },
      }),
    };
    const result = await r.load("missing");
    expect(result.ok).toBe(false);
  });

  test("onChange is optional", () => {
    type ToolMeta = { readonly name: string };
    const r: Resolver<ToolMeta, Tool> = {
      discover: async () => [],
      load: async () => ({
        ok: true,
        value: {
          descriptor: { name: "t", description: "d", inputSchema: {} },
          trustTier: "sandbox",
          execute: async () => ({}),
        },
      }),
    };
    expect(r.onChange).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool input typing
// ---------------------------------------------------------------------------

describe("Tool input typing", () => {
  test("Tool.execute accepts JsonObject args", () => {
    const tool: Tool = {
      descriptor: {
        name: "calc",
        description: "calculator",
        inputSchema: {},
      },
      trustTier: "sandbox",
      execute: async (args) => {
        return { result: args.a };
      },
    };
    expect(tool.descriptor.name).toBe("calc");
  });
});

// ---------------------------------------------------------------------------
// Delegation type tests
// ---------------------------------------------------------------------------

describe("DelegationId branding", () => {
  test("plain string is not assignable to DelegationId", () => {
    // @ts-expect-error — plain string is not assignable to DelegationId
    const _id: DelegationId = "plain-string";
    void _id;
  });

  test("DelegationId is assignable to string", () => {
    const id = "test" as DelegationId;
    const _s: string = id;
    void _s;
    expect(id).toBe("test" as DelegationId);
  });
});

describe("DelegationGrant readonly enforcement", () => {
  test("all properties are readonly", () => {
    const grant: DelegationGrant = {
      id: "g1" as DelegationId,
      issuerId: "agent-1",
      delegateeId: "agent-2",
      scope: { permissions: { allow: ["read_file"] } },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      signature: "abc",
    };
    // @ts-expect-error — cannot assign to readonly property
    grant.id = "g2" as DelegationId;
    // @ts-expect-error — cannot assign to readonly property
    grant.issuerId = "other";
    // @ts-expect-error — cannot assign to readonly property
    grant.scope = { permissions: {} };
    // @ts-expect-error — cannot assign to readonly property
    grant.signature = "tampered";
  });

  test("parentId is optional", () => {
    const root: DelegationGrant = {
      id: "g1" as DelegationId,
      issuerId: "a1",
      delegateeId: "a2",
      scope: { permissions: {} },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: 0,
      expiresAt: 1,
      signature: "sig",
    };
    expect(root.parentId).toBeUndefined();

    const child: DelegationGrant = {
      id: "g2" as DelegationId,
      issuerId: "a2",
      delegateeId: "a3",
      scope: { permissions: {} },
      parentId: "g1" as DelegationId,
      chainDepth: 1,
      maxChainDepth: 3,
      createdAt: 0,
      expiresAt: 1,
      signature: "sig",
    };
    expect(child.parentId).toBe("g1" as DelegationId);
  });
});

describe("DelegationScope", () => {
  test("permissions is required, resources and maxBudget are optional", () => {
    const minimal: DelegationScope = { permissions: { allow: ["*"] } };
    expect(minimal.resources).toBeUndefined();
    expect(minimal.maxBudget).toBeUndefined();

    const full: DelegationScope = {
      permissions: { allow: ["read_file"], deny: ["write_file"] },
      resources: ["read_file:/workspace/**"],
      maxBudget: 100,
    };
    expect(full.resources).toHaveLength(1);
    expect(full.maxBudget).toBe(100);
  });

  test("resources array is readonly", () => {
    const scope: DelegationScope = {
      permissions: {},
      resources: ["a", "b"],
    };
    // @ts-expect-error — cannot assign to readonly property
    scope.resources = [];
  });
});

describe("DelegationVerifyResult narrowing", () => {
  test("narrows to grant on ok: true", () => {
    const result: DelegationVerifyResult = {
      ok: true,
      grant: {
        id: "g1" as DelegationId,
        issuerId: "a1",
        delegateeId: "a2",
        scope: { permissions: {} },
        chainDepth: 0,
        maxChainDepth: 3,
        createdAt: 0,
        expiresAt: 1,
        signature: "sig",
      },
    };
    if (result.ok) {
      const _g: DelegationGrant = result.grant;
      void _g;
    }
  });

  test("narrows to reason on ok: false", () => {
    const result: DelegationVerifyResult = { ok: false, reason: "expired" };
    if (!result.ok) {
      const _r: DelegationDenyReason = result.reason;
      expect(_r).toBe("expired");
    }
  });

  test("reason is not accessible when ok: true", () => {
    const result: DelegationVerifyResult = {
      ok: true,
      grant: {
        id: "g1" as DelegationId,
        issuerId: "a1",
        delegateeId: "a2",
        scope: { permissions: {} },
        chainDepth: 0,
        maxChainDepth: 3,
        createdAt: 0,
        expiresAt: 1,
        signature: "sig",
      },
    };
    if (result.ok) {
      // @ts-expect-error — reason does not exist on success branch
      const _r: string = result.reason;
      void _r;
    }
  });
});

describe("DelegationDenyReason", () => {
  test("accepts all 6 valid reasons", () => {
    const reasons: readonly DelegationDenyReason[] = [
      "expired",
      "revoked",
      "scope_exceeded",
      "chain_depth_exceeded",
      "invalid_signature",
      "unknown_grant",
    ];
    expect(reasons).toHaveLength(6);
  });
});

describe("ScopeChecker interface", () => {
  test("satisfies with minimal implementation", () => {
    const checker: ScopeChecker = {
      isAllowed: (_toolId, _scope) => true,
    };
    expect(checker.isAllowed("read_file", { permissions: { allow: ["*"] } })).toBe(true);
  });

  test("can deny based on custom logic", () => {
    const checker: ScopeChecker = {
      isAllowed: (toolId) => toolId !== "exec",
    };
    expect(checker.isAllowed("read_file", { permissions: {} })).toBe(true);
    expect(checker.isAllowed("exec", { permissions: {} })).toBe(false);
  });

  test("isAllowed is readonly", () => {
    const checker: ScopeChecker = {
      isAllowed: () => true,
    };
    // @ts-expect-error — cannot assign to readonly property
    checker.isAllowed = () => false;
  });
});

describe("RevocationRegistry interface", () => {
  test("satisfies with minimal implementation", () => {
    const revoked = new Set<DelegationId>();
    const registry: RevocationRegistry = {
      isRevoked: (id) => revoked.has(id),
      revoke: (id) => {
        revoked.add(id);
      },
      revokedIds: () => revoked,
    };
    expect(registry.isRevoked("test" as DelegationId)).toBe(false);
  });
});

describe("DelegationConfig", () => {
  test("all fields are required", () => {
    // @ts-expect-error — enabled is required
    const _partial: DelegationConfig = {
      maxChainDepth: 3,
      defaultTtlMs: 3600000,
      maxEntries: 10000,
      cleanupIntervalMs: 60000,
    };
    void _partial;
  });

  test("all properties are readonly", () => {
    const config: DelegationConfig = {
      enabled: true,
      maxChainDepth: 3,
      defaultTtlMs: 3600000,
      maxEntries: 10000,
      cleanupIntervalMs: 60000,
    };
    // @ts-expect-error — cannot assign to readonly property
    config.enabled = false;
    // @ts-expect-error — cannot assign to readonly property
    config.maxChainDepth = 5;
  });
});

describe("DELEGATION well-known token", () => {
  test("narrows component to DelegationComponent", () => {
    const agentLike: Pick<Agent, "component"> = {
      component: <T>(_token: SubsystemToken<T>): T | undefined => undefined,
    };
    const deleg = agentLike.component(DELEGATION);
    if (deleg) {
      const _: DelegationComponent = deleg;
      void _;
    }
    expect(deleg).toBeUndefined();
  });
});

describe("AgentManifest delegation config", () => {
  test("delegation is optional on AgentManifest", () => {
    const withoutDelegation: AgentManifest = {
      name: "test",
      version: "0.0.0",
      model: { name: "gpt-4" },
    };
    expect(withoutDelegation.delegation).toBeUndefined();

    const withDelegation: AgentManifest = {
      name: "test",
      version: "0.0.0",
      model: { name: "gpt-4" },
      delegation: {
        enabled: true,
        maxChainDepth: 3,
        defaultTtlMs: 3600000,
        maxEntries: 10000,
        cleanupIntervalMs: 60000,
      },
    };
    expect(withDelegation.delegation?.enabled).toBe(true);
  });
});
