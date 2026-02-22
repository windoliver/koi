import { describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentManifest,
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineStopReason,
  KoiError,
  KoiMiddleware,
  PermissionConfig,
  Resolver,
  Result,
  SubsystemToken,
  Tool,
} from "../index.js";
import { token } from "../index.js";

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

  test("narrows to tool_call_start", () => {
    const event: EngineEvent = {
      kind: "tool_call_start",
      toolId: "calc",
      input: {},
    };
    if (event.kind === "tool_call_start") {
      expect(event.toolId).toBe("calc");
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
});

describe("Agent component typing", () => {
  test("component returns T | undefined for typed token", () => {
    // Verify the type signature compiles correctly
    const agentLike: Pick<Agent, "component"> = {
      component: <T>(_token: SubsystemToken<T>): T | undefined => undefined,
    };
    const result = agentLike.component(token<{ readonly val: number }>("test"));
    // result is { readonly val: number } | undefined
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Negative type tests for all 6 contracts (#9)
// ---------------------------------------------------------------------------

describe("AgentManifest negative types", () => {
  test("model is required", () => {
    // @ts-expect-error — model is required on AgentManifest
    const _m: AgentManifest = { name: "test" };
    void _m;
  });

  test("name is required", () => {
    // @ts-expect-error — name is required on AgentManifest
    const _m: AgentManifest = { model: { name: "gpt-4" } };
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
// Resolver type tests (#12)
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
          execute: async () => ({}),
        },
      }),
    };
    expect(r.onChange).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool input narrowing test (#7)
// ---------------------------------------------------------------------------

describe("Tool input typing", () => {
  test("Tool.execute accepts Record<string, unknown>", () => {
    const tool: Tool = {
      descriptor: {
        name: "calc",
        description: "calculator",
        inputSchema: {},
      },
      execute: async (input) => {
        // input is Readonly<Record<string, unknown>>
        return { result: input.a };
      },
    };
    expect(tool.descriptor.name).toBe("calc");
  });
});
