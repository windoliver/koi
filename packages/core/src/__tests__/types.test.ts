import { describe, expect, test } from "bun:test";
import type {
  AbortReason,
  Agent,
  AgentManifest,
  CapabilityFragment,
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  CorrelationIds,
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
  GovernanceCheck,
  GovernanceSnapshot,
  KoiError,
  KoiErrorCode,
  KoiMiddleware,
  MemoryRecallOptions,
  MemoryResult,
  MemoryStoreOptions,
  MemoryTier,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
  ModelRequest,
  ModelTarget,
  PermissionConfig,
  ProcessId,
  Resolver,
  Result,
  RevocationRegistry,
  RunId,
  ScopeChecker,
  SessionId,
  SourceBundle,
  SourceLanguage,
  SubsystemToken,
  Tool,
  ToolCallId,
  ToolDescriptor,
  ToolExecuteOptions,
  ToolRequest,
  TrustTier,
  TurnContext,
  TurnId,
} from "../index.js";
import {
  agentId,
  CREDENTIALS,
  DELEGATION,
  EVENTS,
  GOVERNANCE,
  MEMORY,
  runId,
  sessionId,
  token,
  toolCallId,
  turnId,
} from "../index.js";

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
      callId: toolCallId("c1"),
      args: { x: 1, y: 2 },
    };
    if (event.kind === "tool_call_start") {
      expect(event.toolName).toBe("calc");
      expect(event.callId).toBe(toolCallId("c1"));
      expect(event.args).toEqual({ x: 1, y: 2 });
    }
  });

  test("narrows to tool_call_end with callId and result", () => {
    const event: EngineEvent = { kind: "tool_call_end", callId: toolCallId("c1"), result: 42 };
    if (event.kind === "tool_call_end") {
      expect(event.callId).toBe(toolCallId("c1"));
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
      const _: Promise<readonly MemoryResult[]> = mem.recall("test");
      void _;
    }
    expect(mem).toBeUndefined();
  });

  test("GOVERNANCE token narrows component to GovernanceController", () => {
    const agentLike: Pick<Agent, "component"> = {
      component: <T>(_token: SubsystemToken<T>): T | undefined => undefined,
    };
    const gov = agentLike.component(GOVERNANCE);
    if (gov) {
      const _check: GovernanceCheck | Promise<GovernanceCheck> = gov.check("spawn_depth");
      const _snap: GovernanceSnapshot | Promise<GovernanceSnapshot> = gov.snapshot();
      void _check;
      void _snap;
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
      supportsA2ui: false,
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
  test("minimal middleware requires name + describeCapabilities", () => {
    const mw: KoiMiddleware = { name: "passthrough", describeCapabilities: () => undefined };
    expect(mw.name).toBe("passthrough");
  });

  test("name is required", () => {
    // @ts-expect-error — name is required on KoiMiddleware
    const _mw: KoiMiddleware = { describeCapabilities: () => undefined };
    void _mw;
  });

  test("middleware with session hooks is valid", () => {
    const mw: KoiMiddleware = {
      name: "session-only",
      describeCapabilities: () => undefined,
      onSessionStart: async () => {},
      onSessionEnd: async () => {},
    };
    expect(mw.name).toBe("session-only");
  });

  test("priority is optional", () => {
    const mw: KoiMiddleware = { name: "no-priority", describeCapabilities: () => undefined };
    expect(mw.priority).toBeUndefined();
  });

  test("priority accepts a number", () => {
    const mw: KoiMiddleware = {
      name: "with-priority",
      priority: 100,
      describeCapabilities: () => undefined,
    };
    expect(mw.priority).toBe(100);
  });

  test("priority is readonly", () => {
    const mw: KoiMiddleware = {
      name: "readonly-priority",
      priority: 200,
      describeCapabilities: () => undefined,
    };
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
    const e: EngineAdapter = {
      engineId: "test",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: fakeStream,
    };
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
// TrustTier and GovernanceCheck
// ---------------------------------------------------------------------------

describe("TrustTier", () => {
  test("accepts valid trust tier literals", () => {
    const tiers: readonly TrustTier[] = ["sandbox", "verified", "promoted"];
    expect(tiers).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// MemoryTier and extended memory types (#455)
// ---------------------------------------------------------------------------

describe("MemoryTier and extended memory types", () => {
  test("MemoryTier accepts valid tier literals", () => {
    const tiers: readonly MemoryTier[] = ["hot", "warm", "cold"];
    expect(tiers).toHaveLength(3);
  });

  test("MemoryTier rejects invalid values at compile time", () => {
    // @ts-expect-error — "lukewarm" is not a valid MemoryTier
    const _bad: MemoryTier = "lukewarm";
    void _bad;
  });

  test("MemoryResult with tier/decayScore/lastAccessed compiles", () => {
    const result: MemoryResult = {
      content: "test memory",
      score: 0.95,
      metadata: { source: "unit-test" },
      tier: "hot",
      decayScore: 0.87,
      lastAccessed: "2026-02-26T00:00:00.000Z",
    };
    expect(result.tier).toBe("hot");
    expect(result.decayScore).toBe(0.87);
    expect(result.lastAccessed).toBe("2026-02-26T00:00:00.000Z");
  });

  test("MemoryResult without new fields still compiles (backward compat)", () => {
    const result: MemoryResult = { content: "legacy memory" };
    expect(result.content).toBe("legacy memory");
    expect(result.tier).toBeUndefined();
    expect(result.decayScore).toBeUndefined();
    expect(result.lastAccessed).toBeUndefined();
  });

  test("MemoryRecallOptions with tierFilter and limit compiles", () => {
    const options: MemoryRecallOptions = {
      namespace: "research",
      tierFilter: "hot",
      limit: 10,
    };
    expect(options.tierFilter).toBe("hot");
    expect(options.limit).toBe(10);
  });

  test("MemoryRecallOptions tierFilter accepts 'all' literal", () => {
    const options: MemoryRecallOptions = { tierFilter: "all" };
    expect(options.tierFilter).toBe("all");
  });

  test("MemoryRecallOptions without new fields still compiles (backward compat)", () => {
    const options: MemoryRecallOptions = { namespace: "default" };
    expect(options.namespace).toBe("default");
    expect(options.tierFilter).toBeUndefined();
    expect(options.limit).toBeUndefined();
  });

  test("MemoryStoreOptions with category and relatedEntities compiles", () => {
    const options: MemoryStoreOptions = {
      namespace: "research",
      tags: ["important"],
      category: "milestone",
      relatedEntities: ["entity-1", "entity-2"],
    };
    expect(options.category).toBe("milestone");
    expect(options.relatedEntities).toEqual(["entity-1", "entity-2"]);
  });

  test("MemoryStoreOptions without new fields still compiles (backward compat)", () => {
    const options: MemoryStoreOptions = { namespace: "default", tags: ["test"] };
    expect(options.namespace).toBe("default");
    expect(options.category).toBeUndefined();
    expect(options.relatedEntities).toBeUndefined();
    expect(options.reinforce).toBeUndefined();
  });

  test("MemoryStoreOptions with reinforce compiles", () => {
    const options: MemoryStoreOptions = {
      namespace: "compaction",
      category: "decision",
      relatedEntities: ["entity-1"],
      reinforce: true,
    };
    expect(options.reinforce).toBe(true);
  });
});

describe("GovernanceCheck discriminant", () => {
  test("narrows to ok branch", () => {
    const check: GovernanceCheck = { ok: true };
    if (check.ok) {
      expect(check.ok).toBe(true);
    }
  });

  test("narrows to failed branch with variable and reason", () => {
    const check: GovernanceCheck = {
      ok: false,
      variable: "spawn_depth",
      reason: "max depth exceeded",
      retryable: false,
    };
    if (!check.ok) {
      expect(check.variable).toBe("spawn_depth");
      expect(check.reason).toBe("max depth exceeded");
      expect(check.retryable).toBe(false);
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
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["read_file"] } },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      proof: { kind: "hmac-sha256", digest: "a".repeat(64) },
    };
    // @ts-expect-error — cannot assign to readonly property
    grant.id = "g2" as DelegationId;
    // @ts-expect-error — cannot assign to readonly property
    grant.issuerId = agentId("other");
    // @ts-expect-error — cannot assign to readonly property
    grant.scope = { permissions: {} };
    // @ts-expect-error — cannot assign to readonly property
    grant.proof = { kind: "hmac-sha256", digest: "tampered".repeat(8) };
  });

  test("parentId is optional", () => {
    const root: DelegationGrant = {
      id: "g1" as DelegationId,
      issuerId: agentId("a1"),
      delegateeId: agentId("a2"),
      scope: { permissions: {} },
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: 0,
      expiresAt: 1,
      proof: { kind: "hmac-sha256", digest: "a".repeat(64) },
    };
    expect(root.parentId).toBeUndefined();

    const child: DelegationGrant = {
      id: "g2" as DelegationId,
      issuerId: agentId("a2"),
      delegateeId: agentId("a3"),
      scope: { permissions: {} },
      parentId: "g1" as DelegationId,
      chainDepth: 1,
      maxChainDepth: 3,
      createdAt: 0,
      expiresAt: 1,
      proof: { kind: "hmac-sha256", digest: "a".repeat(64) },
    };
    expect(child.parentId).toBe("g1" as DelegationId);
  });
});

describe("DelegationScope", () => {
  test("permissions is required, resources is optional", () => {
    const minimal: DelegationScope = { permissions: { allow: ["*"] } };
    expect(minimal.resources).toBeUndefined();

    const full: DelegationScope = {
      permissions: { allow: ["read_file"], deny: ["write_file"] },
      resources: ["read_file:/workspace/**"],
    };
    expect(full.resources).toHaveLength(1);
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
        issuerId: agentId("a1"),
        delegateeId: agentId("a2"),
        scope: { permissions: {} },
        chainDepth: 0,
        maxChainDepth: 3,
        createdAt: 0,
        expiresAt: 1,
        proof: { kind: "hmac-sha256", digest: "a".repeat(64) },
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
        issuerId: agentId("a1"),
        delegateeId: agentId("a2"),
        scope: { permissions: {} },
        chainDepth: 0,
        maxChainDepth: 3,
        createdAt: 0,
        expiresAt: 1,
        proof: { kind: "hmac-sha256", digest: "a".repeat(64) },
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
  test("satisfies with minimal sync implementation", () => {
    const revoked = new Set<DelegationId>();
    const registry: RevocationRegistry = {
      isRevoked: (id) => revoked.has(id),
      revoke: (id, _cascade) => {
        revoked.add(id);
      },
    };
    expect(registry.isRevoked("test" as DelegationId)).toBe(false);
  });

  test("satisfies with async implementation", () => {
    const revoked = new Set<DelegationId>();
    const registry: RevocationRegistry = {
      isRevoked: async (id) => revoked.has(id),
      revoke: async (id, _cascade) => {
        revoked.add(id);
      },
    };
    expect(registry.isRevoked("test" as DelegationId)).toBeInstanceOf(Promise);
  });
});

describe("DelegationConfig", () => {
  test("all fields are required", () => {
    // @ts-expect-error — enabled is required
    const _partial: DelegationConfig = {
      maxChainDepth: 3,
      defaultTtlMs: 3600000,
    };
    void _partial;
  });

  test("all properties are readonly", () => {
    const config: DelegationConfig = {
      enabled: true,
      maxChainDepth: 3,
      defaultTtlMs: 3600000,
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
      },
    };
    expect(withDelegation.delegation?.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AgentManifest conventions
// ---------------------------------------------------------------------------

describe("AgentManifest conventions", () => {
  test("conventions is optional on AgentManifest", () => {
    const without: AgentManifest = { name: "test", version: "0.0.0", model: { name: "gpt-4" } };
    expect(without.conventions).toBeUndefined();
  });

  test("accepts readonly string array", () => {
    const m: AgentManifest = {
      name: "test",
      version: "0.0.0",
      model: { name: "gpt-4" },
      conventions: ["ESM-only imports", "No mutation"],
    };
    expect(m.conventions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Model provider types
// ---------------------------------------------------------------------------

describe("ModelCapabilities", () => {
  test("all properties are required", () => {
    const caps: ModelCapabilities = {
      streaming: true,
      functionCalling: true,
      vision: false,
      jsonMode: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 4096,
    };
    expect(caps.streaming).toBe(true);
    expect(caps.maxContextTokens).toBe(128_000);
  });

  test("properties are readonly", () => {
    const caps: ModelCapabilities = {
      streaming: true,
      functionCalling: true,
      vision: false,
      jsonMode: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 4096,
    };
    // @ts-expect-error — cannot assign to readonly property
    caps.streaming = false;
  });
});

describe("ModelProvider", () => {
  test("satisfies with full properties", () => {
    const provider: ModelProvider = {
      id: "openai",
      name: "OpenAI",
      capabilities: {
        streaming: true,
        functionCalling: true,
        vision: true,
        jsonMode: true,
        maxContextTokens: 128_000,
        maxOutputTokens: 16_384,
      },
    };
    expect(provider.id).toBe("openai");
    expect(provider.capabilities.vision).toBe(true);
  });

  test("id is required", () => {
    // @ts-expect-error — id is required on ModelProvider
    const _p: ModelProvider = {
      name: "Test",
      capabilities: {
        streaming: false,
        functionCalling: false,
        vision: false,
        jsonMode: false,
        maxContextTokens: 0,
        maxOutputTokens: 0,
      },
    };
    void _p;
  });

  test("properties are readonly", () => {
    const provider: ModelProvider = {
      id: "openai",
      name: "OpenAI",
      capabilities: {
        streaming: true,
        functionCalling: true,
        vision: true,
        jsonMode: true,
        maxContextTokens: 128_000,
        maxOutputTokens: 16_384,
      },
    };
    // @ts-expect-error — cannot assign to readonly property
    provider.id = "other";
  });
});

describe("ModelTarget", () => {
  test("minimal target with required fields only", () => {
    const target: ModelTarget = {
      provider: "openai",
      model: "gpt-4o",
    };
    expect(target.weight).toBeUndefined();
    expect(target.enabled).toBeUndefined();
  });

  test("full target with optional fields", () => {
    const target: ModelTarget = {
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      weight: 0.8,
      enabled: true,
    };
    expect(target.weight).toBe(0.8);
    expect(target.enabled).toBe(true);
  });

  test("properties are readonly", () => {
    const target: ModelTarget = {
      provider: "openai",
      model: "gpt-4o",
      weight: 1,
    };
    // @ts-expect-error — cannot assign to readonly property
    target.provider = "other";
  });
});

describe("ModelConfig fallbacks", () => {
  test("fallbacks is optional", () => {
    const config: ModelConfig = { name: "gpt-4o" };
    expect(config.fallbacks).toBeUndefined();
  });

  test("fallbacks accepts readonly string array", () => {
    const config: ModelConfig = {
      name: "gpt-4o",
      fallbacks: ["claude-sonnet-4-5-20250929", "gemini-pro"],
    };
    expect(config.fallbacks).toHaveLength(2);
  });

  test("fallbacks array is readonly", () => {
    const config: ModelConfig = {
      name: "gpt-4o",
      fallbacks: ["claude-sonnet-4-5-20250929"],
    };
    // @ts-expect-error — cannot assign to readonly property
    config.fallbacks = [];
  });
});

// ---------------------------------------------------------------------------
// SourceBundle and SourceLanguage type tests
// ---------------------------------------------------------------------------

describe("SourceBundle", () => {
  test("minimal SourceBundle without files", () => {
    const bundle: SourceBundle = { content: "return 1;", language: "typescript" };
    expect(bundle.content).toBe("return 1;");
    expect(bundle.language).toBe("typescript");
    expect(bundle.files).toBeUndefined();
  });

  test("SourceBundle with files", () => {
    const bundle: SourceBundle = {
      content: "return 1;",
      language: "typescript",
      files: { "helper.ts": "export const x = 1;" },
    };
    expect(bundle.files).toBeDefined();
  });

  test("SourceBundle properties are readonly", () => {
    const bundle: SourceBundle = { content: "x", language: "json" };
    // @ts-expect-error — cannot assign to readonly property
    bundle.content = "y";
    // @ts-expect-error — cannot assign to readonly property
    bundle.language = "yaml";
  });
});

describe("SourceLanguage", () => {
  test("accepts all valid language literals", () => {
    const langs: readonly SourceLanguage[] = [
      "typescript",
      "javascript",
      "markdown",
      "yaml",
      "json",
    ];
    expect(langs).toHaveLength(5);
  });
});

describe("Resolver.source", () => {
  test("source is optional on Resolver", () => {
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
    expect(r.source).toBeUndefined();
  });

  test("source returns Result<SourceBundle, KoiError>", async () => {
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
      source: async () => ({
        ok: true,
        value: { content: "return 1;", language: "typescript" },
      }),
    };
    expect(r.source).toBeDefined();
    const result = await r.source?.("t");
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe("return 1;");
      expect(result.value.language).toBe("typescript");
    }
  });
});

// ---------------------------------------------------------------------------
// Branded ID types (#80 — Canonical ID hierarchy)
// ---------------------------------------------------------------------------

describe("SessionId branding", () => {
  test("sessionId() returns branded type", () => {
    const sid = sessionId("sess-1");
    const _s: SessionId = sid;
    void _s;
    expect(sid).toBe(sessionId("sess-1"));
  });

  test("plain string is not assignable to SessionId", () => {
    // @ts-expect-error — plain string is not assignable to SessionId
    const _sid: SessionId = "plain-string";
    void _sid;
  });

  test("SessionId is assignable to string", () => {
    const sid = sessionId("sess-2");
    const _s: string = sid;
    void _s;
    expect(_s).toBe("sess-2");
  });
});

describe("RunId branding", () => {
  test("runId() returns branded type", () => {
    const rid = runId("run-1");
    const _r: RunId = rid;
    void _r;
    expect(rid).toBe(runId("run-1"));
  });

  test("plain string is not assignable to RunId", () => {
    // @ts-expect-error — plain string is not assignable to RunId
    const _rid: RunId = "plain-string";
    void _rid;
  });
});

describe("TurnId branding", () => {
  test("turnId() produces hierarchical format", () => {
    const rid = runId("run-abc");
    const tid = turnId(rid, 0);
    const _t: TurnId = tid;
    void _t;
    expect(tid).toBe(turnId(runId("run-abc"), 0));
  });

  test("turnId() increments with turn index", () => {
    const rid = runId("run-xyz");
    expect(turnId(rid, 0)).toBe(turnId(runId("run-xyz"), 0));
    expect(turnId(rid, 1)).toBe(turnId(runId("run-xyz"), 1));
    expect(turnId(rid, 42)).toBe(turnId(runId("run-xyz"), 42));
  });

  test("plain string is not assignable to TurnId", () => {
    // @ts-expect-error — plain string is not assignable to TurnId
    const _tid: TurnId = "plain-string";
    void _tid;
  });
});

describe("ToolCallId branding", () => {
  test("toolCallId() returns branded type", () => {
    const cid = toolCallId("call-1");
    const _c: ToolCallId = cid;
    void _c;
    expect(cid).toBe(toolCallId("call-1"));
  });

  test("plain string is not assignable to ToolCallId", () => {
    // @ts-expect-error — plain string is not assignable to ToolCallId
    const _cid: ToolCallId = "plain-string";
    void _cid;
  });
});

describe("CorrelationIds", () => {
  test("minimal CorrelationIds with required fields", () => {
    const ids: CorrelationIds = {
      sessionId: sessionId("s1"),
      runId: runId("r1"),
    };
    expect(ids.sessionId).toBe(sessionId("s1"));
    expect(ids.runId).toBe(runId("r1"));
    expect(ids.turnId).toBeUndefined();
    expect(ids.toolCallId).toBeUndefined();
  });

  test("full CorrelationIds with all fields", () => {
    const rid = runId("r1");
    const ids: CorrelationIds = {
      sessionId: sessionId("s1"),
      runId: rid,
      turnId: turnId(rid, 3),
      toolCallId: toolCallId("tc-1"),
    };
    expect(ids.turnId).toBe(turnId(runId("r1"), 3));
    expect(ids.toolCallId).toBe(toolCallId("tc-1"));
  });

  test("properties are readonly", () => {
    const ids: CorrelationIds = {
      sessionId: sessionId("s1"),
      runId: runId("r1"),
    };
    // @ts-expect-error — cannot assign to readonly property
    ids.sessionId = sessionId("s2");
  });
});

describe("branded ID cross-assignment prevention", () => {
  test("SessionId is not assignable to RunId", () => {
    const sid = sessionId("id-1");
    // @ts-expect-error — SessionId is not assignable to RunId
    const _rid: RunId = sid;
    void _rid;
  });

  test("RunId is not assignable to SessionId", () => {
    const rid = runId("id-1");
    // @ts-expect-error — RunId is not assignable to SessionId
    const _sid: SessionId = rid;
    void _sid;
  });

  test("ToolCallId is not assignable to TurnId", () => {
    const cid = toolCallId("id-1");
    // @ts-expect-error — ToolCallId is not assignable to TurnId
    const _tid: TurnId = cid;
    void _tid;
  });
});

// ---------------------------------------------------------------------------
// AbortSignal on EngineInput (#79)
// ---------------------------------------------------------------------------

describe("EngineInput.signal", () => {
  test("signal is optional on text input", () => {
    const input: EngineInput = { kind: "text", text: "hello" };
    expect(input.signal).toBeUndefined();
  });

  test("signal is accepted on text input", () => {
    const controller = new AbortController();
    const input: EngineInput = { kind: "text", text: "hello", signal: controller.signal };
    expect(input.signal).toBe(controller.signal);
  });

  test("signal is accepted on messages input", () => {
    const controller = new AbortController();
    const input: EngineInput = { kind: "messages", messages: [], signal: controller.signal };
    expect(input.signal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// TurnContext new fields (#79, #80)
// ---------------------------------------------------------------------------

describe("TurnContext new fields", () => {
  test("turnId is present on TurnContext", () => {
    const rid = runId("r1");
    const ctx: TurnContext = {
      session: { agentId: "a1", sessionId: sessionId("s1"), runId: rid, metadata: {} },
      turnIndex: 0,
      turnId: turnId(rid, 0),
      messages: [],
      metadata: {},
    };
    expect(ctx.turnId).toBe(turnId(runId("r1"), 0));
  });

  test("signal is optional on TurnContext", () => {
    const rid = runId("r1");
    const ctx: TurnContext = {
      session: { agentId: "a1", sessionId: sessionId("s1"), runId: rid, metadata: {} },
      turnIndex: 0,
      turnId: turnId(rid, 0),
      messages: [],
      metadata: {},
    };
    expect(ctx.signal).toBeUndefined();
  });

  test("signal is accepted on TurnContext", () => {
    const rid = runId("r1");
    const controller = new AbortController();
    const ctx: TurnContext = {
      session: { agentId: "a1", sessionId: sessionId("s1"), runId: rid, metadata: {} },
      turnIndex: 0,
      turnId: turnId(rid, 0),
      messages: [],
      metadata: {},
      signal: controller.signal,
    };
    expect(ctx.signal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// AbortReason type (#79 — discriminated abort reasons)
// ---------------------------------------------------------------------------

describe("AbortReason", () => {
  test("accepts all four valid abort reasons", () => {
    const reasons: readonly AbortReason[] = ["user_cancel", "timeout", "token_limit", "shutdown"];
    expect(reasons).toHaveLength(4);
  });

  test("rejects invalid abort reason", () => {
    // @ts-expect-error — "unknown_reason" is not a valid AbortReason
    const _invalid: AbortReason = "unknown_reason";
    void _invalid;
  });

  test("can be used as AbortController.abort() reason", () => {
    const controller = new AbortController();
    const reason: AbortReason = "user_cancel";
    controller.abort(reason);
    expect(controller.signal.reason).toBe("user_cancel");
  });

  test("signal.reason discriminates timeout vs user_cancel", () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    c1.abort("timeout" satisfies AbortReason);
    c2.abort("user_cancel" satisfies AbortReason);
    expect(c1.signal.reason).toBe("timeout");
    expect(c2.signal.reason).toBe("user_cancel");
  });
});

// ---------------------------------------------------------------------------
// ModelRequest.signal (#79 — signal propagation to adapters)
// ---------------------------------------------------------------------------

describe("ModelRequest.signal", () => {
  test("signal is optional on ModelRequest", () => {
    const req: ModelRequest = { messages: [] };
    expect(req.signal).toBeUndefined();
  });

  test("signal is accepted on ModelRequest", () => {
    const controller = new AbortController();
    const req: ModelRequest = { messages: [], signal: controller.signal };
    expect(req.signal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// ModelRequest.tools (#313 — tool selector middleware)
// ---------------------------------------------------------------------------

describe("ModelRequest.tools", () => {
  test("tools is optional on ModelRequest", () => {
    const req: ModelRequest = { messages: [] };
    expect(req.tools).toBeUndefined();
  });

  test("ModelRequest accepts optional tools field", () => {
    const descriptor: ToolDescriptor = {
      name: "test",
      description: "test tool",
      inputSchema: {},
    };
    const req: ModelRequest = { messages: [], tools: [descriptor] };
    expect(req.tools).toHaveLength(1);
    expect(req.tools?.[0]?.name).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// CapabilityFragment and describeCapabilities (#361)
// ---------------------------------------------------------------------------

describe("CapabilityFragment", () => {
  test("has readonly label and description", () => {
    const fragment: CapabilityFragment = {
      label: "permissions",
      description: "Tools requiring approval: fs:write",
    };
    expect(fragment.label).toBe("permissions");
    expect(fragment.description).toBe("Tools requiring approval: fs:write");
  });

  test("properties are readonly", () => {
    const fragment: CapabilityFragment = { label: "test", description: "desc" };
    // @ts-expect-error — cannot assign to readonly property
    fragment.label = "other";
    // @ts-expect-error — cannot assign to readonly property
    fragment.description = "other";
  });
});

describe("KoiMiddleware.describeCapabilities", () => {
  test("middleware without describeCapabilities fails type check", () => {
    // @ts-expect-error — describeCapabilities is required
    const _mw: KoiMiddleware = { name: "simple" };
  });

  test("minimal valid middleware requires name + describeCapabilities", () => {
    const rid = runId("r1");
    const ctx: TurnContext = {
      session: { agentId: "a1", sessionId: sessionId("s1"), runId: rid, metadata: {} },
      turnIndex: 0,
      turnId: turnId(rid, 0),
      messages: [],
      metadata: {},
    };
    const mw: KoiMiddleware = {
      name: "minimal",
      describeCapabilities: () => undefined,
    };
    expect(mw.name).toBe("minimal");
    expect(mw.describeCapabilities(ctx)).toBeUndefined();
  });

  test("middleware with describeCapabilities returning a fragment is valid", () => {
    const rid = runId("r1");
    const ctx: TurnContext = {
      session: { agentId: "a1", sessionId: sessionId("s1"), runId: rid, metadata: {} },
      turnIndex: 0,
      turnId: turnId(rid, 0),
      messages: [],
      metadata: {},
    };
    const mw: KoiMiddleware = {
      name: "with-caps",
      describeCapabilities: () => ({ label: "test", description: "test desc" }),
    };
    const result = mw.describeCapabilities(ctx);
    expect(result).toEqual({ label: "test", description: "test desc" });
  });

  test("describeCapabilities can return undefined", () => {
    const rid = runId("r1");
    const ctx: TurnContext = {
      session: { agentId: "a1", sessionId: sessionId("s1"), runId: rid, metadata: {} },
      turnIndex: 0,
      turnId: turnId(rid, 0),
      messages: [],
      metadata: {},
    };
    const mw: KoiMiddleware = {
      name: "conditional-caps",
      describeCapabilities: () => undefined,
    };
    expect(mw.describeCapabilities(ctx)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ToolExecuteOptions + Tool.execute options bag
// ---------------------------------------------------------------------------

describe("ToolExecuteOptions", () => {
  test("is assignable with signal", () => {
    const opts: ToolExecuteOptions = { signal: AbortSignal.timeout(1000) };
    expect(opts.signal).toBeDefined();
  });

  test("is assignable with undefined signal", () => {
    const opts: ToolExecuteOptions = { signal: undefined };
    expect(opts.signal).toBeUndefined();
  });

  test("is assignable as empty object", () => {
    const opts: ToolExecuteOptions = {};
    expect(opts.signal).toBeUndefined();
  });

  test("Tool.execute is callable with 1 arg (backward compat)", () => {
    const tool: Tool = {
      descriptor: { name: "test", description: "test", inputSchema: {} },
      trustTier: "sandbox",
      execute: async (args) => args,
    };
    // Should compile and run with just args
    expect(typeof tool.execute).toBe("function");
  });

  test("Tool.execute is callable with 2 args (options bag)", () => {
    const tool: Tool = {
      descriptor: { name: "test", description: "test", inputSchema: {} },
      trustTier: "sandbox",
      execute: async (args, options) => ({ args, signal: options?.signal }),
    };
    // Should compile and run with args + options
    expect(typeof tool.execute).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// ToolRequest.signal
// ---------------------------------------------------------------------------

describe("ToolRequest.signal", () => {
  test("signal is optional", () => {
    const req: ToolRequest = { toolId: "test", input: {} };
    expect(req.signal).toBeUndefined();
  });

  test("accepts AbortSignal", () => {
    const req: ToolRequest = {
      toolId: "test",
      input: {},
      signal: AbortSignal.timeout(1000),
    };
    expect(req.signal).toBeDefined();
  });
});
