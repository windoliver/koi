import { describe, expect, test } from "bun:test";
import type { JsonObject, Tool } from "@koi/core";
import { ACKNOWLEDGE_UNSANDBOXED_EXECUTION, createExecuteCodeTool } from "../execute-code-tool.js";

const ACK = ACKNOWLEDGE_UNSANDBOXED_EXECUTION;

function unwrap(result: ReturnType<typeof createExecuteCodeTool>): Tool {
  if (!result.ok) throw new Error(`createExecuteCodeTool failed: ${result.error.message}`);
  return result.value;
}

describe("createExecuteCodeTool — timeout_ms validation", () => {
  test("rejects timeout_ms = 0 (does not silently widen to default)", async () => {
    const tool = unwrap(
      createExecuteCodeTool({
        acknowledgeUnsandboxedExecution: ACK,
        tools: new Map(),
        defaultTimeoutMs: 50,
      }),
    );
    await expect(
      tool.execute({ script: "return 1;", timeout_ms: 0 } satisfies JsonObject),
    ).rejects.toThrow(/timeout_ms must be a positive finite number/i);
  });

  test("rejects negative timeout_ms", async () => {
    const tool = unwrap(
      createExecuteCodeTool({ tools: new Map(), acknowledgeUnsandboxedExecution: ACK }),
    );
    await expect(
      tool.execute({ script: "return 1;", timeout_ms: -1 } satisfies JsonObject),
    ).rejects.toThrow(/timeout_ms must be a positive finite number/i);
  });

  test("rejects non-numeric timeout_ms", async () => {
    const tool = unwrap(
      createExecuteCodeTool({ tools: new Map(), acknowledgeUnsandboxedExecution: ACK }),
    );
    await expect(
      tool.execute({ script: "return 1;", timeout_ms: "fast" } satisfies JsonObject),
    ).rejects.toThrow(/timeout_ms must be a positive finite number/i);
  });

  test("rejects defaultTimeoutMs = 0 at construction", () => {
    const result = createExecuteCodeTool({
      acknowledgeUnsandboxedExecution: ACK,
      tools: new Map(),
      defaultTimeoutMs: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toMatch(/defaultTimeoutMs/i);
    }
  });

  test("rejects negative defaultTimeoutMs at construction", () => {
    const result = createExecuteCodeTool({
      acknowledgeUnsandboxedExecution: ACK,
      tools: new Map(),
      defaultTimeoutMs: -10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects NaN defaultTimeoutMs at construction", () => {
    const result = createExecuteCodeTool({
      acknowledgeUnsandboxedExecution: ACK,
      tools: new Map(),
      defaultTimeoutMs: Number.NaN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects defaultTimeoutMs > MAX_TIMEOUT_MS at construction", () => {
    // Prevent a misconfiguration from granting 1-hour-long execution windows
    // when the schema/docs advertise a 5-minute maximum.
    const result = createExecuteCodeTool({
      acknowledgeUnsandboxedExecution: ACK,
      tools: new Map(),
      defaultTimeoutMs: 3_600_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toMatch(/defaultTimeoutMs/i);
    }
  });

  test("rejects Infinity defaultTimeoutMs at construction", () => {
    const result = createExecuteCodeTool({
      acknowledgeUnsandboxedExecution: ACK,
      tools: new Map(),
      defaultTimeoutMs: Number.POSITIVE_INFINITY,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });
});

describe("createExecuteCodeTool — abort signal propagation", () => {
  test("aborting execute_code cancels worker and in-flight inner tool", async () => {
    let innerSignal: AbortSignal | undefined;
    const watch: Tool = {
      descriptor: {
        name: "watch",
        description: "watch",
        inputSchema: { type: "object", properties: {} },
        origin: "operator",
      },
      origin: "operator",
      policy: { sandbox: false, capabilities: {} },
      execute: async (_args, ctx) =>
        new Promise((_resolve, reject) => {
          innerSignal = ctx?.signal;
          ctx?.signal?.addEventListener("abort", () => reject(new Error("inner-aborted")));
        }),
    };

    const toolResult = createExecuteCodeTool({
      acknowledgeUnsandboxedExecution: ACK,
      tools: new Map([["watch", watch]]),
    });
    expect(toolResult.ok).toBe(true);
    if (!toolResult.ok) return;
    const tool = toolResult.value;

    const controller = new AbortController();
    const userReason = new Error("outer-cancel");
    setTimeout(() => controller.abort(userReason), 50);

    const scriptResult = (await tool.execute(
      { script: `await tools.watch({}); return "never";` } satisfies JsonObject,
      { signal: controller.signal },
    )) as { readonly ok: boolean; readonly error?: string };

    expect(scriptResult.ok).toBe(false);
    expect(scriptResult.error).toMatch(/aborted/i);
    expect(innerSignal?.aborted).toBe(true);
    expect(innerSignal?.reason).toBe(userReason);
  });
});

describe("createExecuteCodeTool — trust gate", () => {
  test("refuses construction without acknowledgeUnsandboxedExecution", () => {
    // @ts-expect-error — intentionally omitting required acknowledgement
    const result = createExecuteCodeTool({ tools: new Map() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toMatch(/acknowledgeUnsandboxedExecution/);
    }
  });

  test("refuses construction with the wrong acknowledgement string", () => {
    const result = createExecuteCodeTool({
      // @ts-expect-error — intentionally wrong sentinel value
      acknowledgeUnsandboxedExecution: "yes",
      tools: new Map(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PERMISSION");
  });

  test("constructs successfully with the correct acknowledgement", () => {
    const result = createExecuteCodeTool({
      acknowledgeUnsandboxedExecution: ACK,
      tools: new Map(),
    });
    expect(result.ok).toBe(true);
  });

  test("accepts undefined timeout_ms (uses default)", async () => {
    const tool = unwrap(
      createExecuteCodeTool({
        acknowledgeUnsandboxedExecution: ACK,
        tools: new Map(),
        defaultTimeoutMs: 1000,
      }),
    );
    const result = (await tool.execute({ script: "return 42;" } satisfies JsonObject)) as {
      readonly ok: boolean;
      readonly result: unknown;
    };
    expect(result.ok).toBe(true);
    expect(result.result).toBe(42);
  });
});
