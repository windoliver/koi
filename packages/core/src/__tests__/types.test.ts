import { describe, expect, test } from "bun:test";
import type {
  Agent,
  ContentBlock,
  EngineEvent,
  EngineInput,
  EngineStopReason,
  FilesystemPolicy,
  KoiError,
  Result,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
  SandboxResult,
  SandboxTier,
  SubsystemToken,
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
    const block: ContentBlock = { kind: "file", url: "https://x.com/f", mimeType: "text/plain" };
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
    const block: ContentBlock = { kind: "file", url: "https://x.com/f", mimeType: "text/plain" };
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
    const event: EngineEvent = { kind: "tool_call_start", toolId: "calc", input: {} };
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
        metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
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

describe("SandboxTier", () => {
  test("accepts valid tier literals", () => {
    const tiers: readonly SandboxTier[] = ["sandbox", "verified", "promoted"];
    expect(tiers).toHaveLength(3);
  });

  test("rejects invalid tier literal", () => {
    // @ts-expect-error — "untrusted" is not a valid SandboxTier
    const _t: SandboxTier = "untrusted";
    void _t;
  });
});

describe("SandboxProfile readonly enforcement", () => {
  test("tier is readonly", () => {
    const profile: SandboxProfile = {
      tier: "sandbox",
      filesystem: {},
      network: { allow: false },
      resources: {},
    };
    // @ts-expect-error — cannot assign to readonly property
    profile.tier = "promoted";
  });

  test("network is readonly", () => {
    const profile: SandboxProfile = {
      tier: "sandbox",
      filesystem: {},
      network: { allow: false },
      resources: {},
    };
    // @ts-expect-error — cannot assign to readonly property
    profile.network = { allow: true };
  });
});

describe("SandboxResult", () => {
  test("properties are accessible", () => {
    const result: SandboxResult = {
      exitCode: 0,
      stdout: "hello",
      stderr: "",
      durationMs: 100,
      timedOut: false,
      oomKilled: false,
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  test("signal is optional", () => {
    const result: SandboxResult = {
      exitCode: 137,
      stdout: "",
      stderr: "",
      signal: "SIGKILL",
      durationMs: 5000,
      timedOut: false,
      oomKilled: true,
    };
    expect(result.signal).toBe("SIGKILL");
  });
});

describe("FilesystemPolicy optional properties", () => {
  test("all properties are optional", () => {
    const empty: FilesystemPolicy = {};
    expect(empty.allowRead).toBeUndefined();
    expect(empty.denyRead).toBeUndefined();
    expect(empty.allowWrite).toBeUndefined();
    expect(empty.denyWrite).toBeUndefined();
  });

  test("accepts populated policy", () => {
    const policy: FilesystemPolicy = {
      allowRead: ["/usr", "/bin"],
      denyRead: ["~/.ssh"],
      allowWrite: ["/tmp"],
    };
    expect(policy.allowRead).toHaveLength(2);
    expect(policy.denyRead).toHaveLength(1);
  });
});

describe("SandboxAdapter contract", () => {
  test("adapter has name and create method", () => {
    const adapter: SandboxAdapter = {
      name: "test",
      create: async (_profile: SandboxProfile): Promise<SandboxInstance> => {
        return {
          exec: async () => ({
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: 0,
            timedOut: false,
            oomKilled: false,
          }),
          readFile: async () => new Uint8Array(),
          writeFile: async () => {},
          destroy: async () => {},
        };
      },
    };
    expect(adapter.name).toBe("test");
    expect(typeof adapter.create).toBe("function");
  });

  test("instance exec returns SandboxResult", async () => {
    const instance: SandboxInstance = {
      exec: async () => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 10,
        timedOut: false,
        oomKilled: false,
      }),
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      destroy: async () => {},
    };
    const result = await instance.exec("/bin/echo", ["hello"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  test("adapter name is readonly", () => {
    const adapter: SandboxAdapter = {
      name: "test",
      create: async () => ({
        exec: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          oomKilled: false,
        }),
        readFile: async () => new Uint8Array(),
        writeFile: async () => {},
        destroy: async () => {},
      }),
    };
    // @ts-expect-error — cannot assign to readonly property
    adapter.name = "other";
  });
});
