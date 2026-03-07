import { describe, expect, mock, test } from "bun:test";
import type { SandboxResult, Tool } from "@koi/core";
import { createExecuteCodeProvider } from "./execute-code-tool.js";
import type { SandboxStack } from "./types.js";

function createMockStack(executeFn?: SandboxStack["executor"]["execute"]): SandboxStack {
  return {
    executor: {
      execute: mock(
        executeFn ??
          (() =>
            Promise.resolve({
              ok: true as const,
              value: { output: "result", durationMs: 10 } satisfies SandboxResult,
            })),
      ),
    },
    instance: undefined,
    warmup: mock(() => Promise.resolve()),
    dispose: mock(() => Promise.resolve()),
  };
}

describe("createExecuteCodeProvider", () => {
  test("returns ComponentProvider with correct name", () => {
    const stack = createMockStack();
    const provider = createExecuteCodeProvider(stack);

    expect(provider.name).toBe("sandbox-stack");
  });

  test("attach returns map with tool:execute_code key", async () => {
    const stack = createMockStack();
    const provider = createExecuteCodeProvider(stack);

    const result = await provider.attach({} as Parameters<typeof provider.attach>[0]);

    expect(result).toBeInstanceOf(Map);
    const map = result as ReadonlyMap<string, unknown>;
    expect(map.has("tool:execute_code")).toBe(true);
  });

  test("tool has correct descriptor", async () => {
    const stack = createMockStack();
    const provider = createExecuteCodeProvider(stack);
    const result = await provider.attach({} as Parameters<typeof provider.attach>[0]);
    const map = result as ReadonlyMap<string, unknown>;
    const tool = map.get("tool:execute_code") as Tool;

    expect(tool.descriptor.name).toBe("execute_code");
    expect(tool.descriptor.description).toContain("sandbox");
    expect(tool.policy.sandbox).toBe(true);
  });

  test("tool execute delegates to stack.executor on success", async () => {
    const stack = createMockStack();
    const provider = createExecuteCodeProvider(stack);
    const result = await provider.attach({} as Parameters<typeof provider.attach>[0]);
    const map = result as ReadonlyMap<string, unknown>;
    const tool = map.get("tool:execute_code") as Tool;

    const output = await tool.execute({ code: "console.log(42)", timeoutMs: 5000 });

    expect(output).toEqual({ output: "result" });
    expect(stack.executor.execute).toHaveBeenCalledTimes(1);
  });

  test("tool execute handles error result", async () => {
    const stack = createMockStack(() =>
      Promise.resolve({
        ok: false as const,
        error: { code: "TIMEOUT" as const, message: "Execution timed out", durationMs: 5000 },
      }),
    );
    const provider = createExecuteCodeProvider(stack);
    const result = await provider.attach({} as Parameters<typeof provider.attach>[0]);
    const map = result as ReadonlyMap<string, unknown>;
    const tool = map.get("tool:execute_code") as Tool;

    const output = await tool.execute({ code: "slow()" });

    expect(output).toEqual({ error: "Execution timed out" });
  });

  test("tool uses default timeout when not specified", async () => {
    const stack = createMockStack();
    const provider = createExecuteCodeProvider(stack);
    const result = await provider.attach({} as Parameters<typeof provider.attach>[0]);
    const map = result as ReadonlyMap<string, unknown>;
    const tool = map.get("tool:execute_code") as Tool;

    await tool.execute({ code: "test" });

    const callArgs = (stack.executor.execute as ReturnType<typeof mock>).mock.calls[0];
    expect(callArgs?.[2]).toBe(30_000);
  });

  test("tool schema does not include language parameter", async () => {
    const stack = createMockStack();
    const provider = createExecuteCodeProvider(stack);
    const result = await provider.attach({} as Parameters<typeof provider.attach>[0]);
    const map = result as ReadonlyMap<string, unknown>;
    const tool = map.get("tool:execute_code") as Tool;

    const props = (tool.descriptor.inputSchema as { readonly properties: Record<string, unknown> })
      .properties;
    expect(props).not.toHaveProperty("language");
    expect(props).toHaveProperty("code");
    expect(props).toHaveProperty("input");
    expect(props).toHaveProperty("timeoutMs");
  });

  test("output is truncated when it exceeds maxOutputBytes", async () => {
    const longOutput = "x".repeat(200);
    const stack = createMockStack(() =>
      Promise.resolve({
        ok: true as const,
        value: { output: longOutput, durationMs: 10 } satisfies SandboxResult,
      }),
    );
    const provider = createExecuteCodeProvider(stack, { maxOutputBytes: 50 });
    const result = await provider.attach({} as Parameters<typeof provider.attach>[0]);
    const map = result as ReadonlyMap<string, unknown>;
    const tool = map.get("tool:execute_code") as Tool;

    const output = (await tool.execute({ code: "big" })) as { readonly output: string };

    expect(output.output).toContain("[output truncated");
    expect(output.output).toContain("50 byte limit");
    expect(output.output.length).toBeLessThan(longOutput.length);
  });

  test("output is not truncated when within maxOutputBytes", async () => {
    const shortOutput = "hello";
    const stack = createMockStack(() =>
      Promise.resolve({
        ok: true as const,
        value: { output: shortOutput, durationMs: 10 } satisfies SandboxResult,
      }),
    );
    const provider = createExecuteCodeProvider(stack, { maxOutputBytes: 1000 });
    const result = await provider.attach({} as Parameters<typeof provider.attach>[0]);
    const map = result as ReadonlyMap<string, unknown>;
    const tool = map.get("tool:execute_code") as Tool;

    const output = (await tool.execute({ code: "small" })) as { readonly output: string };

    expect(output.output).toBe("hello");
  });

  test("non-string output is not truncated", async () => {
    const objectOutput = { data: [1, 2, 3] };
    const stack = createMockStack(() =>
      Promise.resolve({
        ok: true as const,
        value: { output: objectOutput, durationMs: 10 } satisfies SandboxResult,
      }),
    );
    const provider = createExecuteCodeProvider(stack, { maxOutputBytes: 5 });
    const result = await provider.attach({} as Parameters<typeof provider.attach>[0]);
    const map = result as ReadonlyMap<string, unknown>;
    const tool = map.get("tool:execute_code") as Tool;

    const output = (await tool.execute({ code: "obj" })) as { readonly output: unknown };

    expect(output.output).toEqual({ data: [1, 2, 3] });
  });

  test("default maxOutputBytes is 10 MB when options not provided", async () => {
    const output = "y".repeat(1000);
    const stack = createMockStack(() =>
      Promise.resolve({
        ok: true as const,
        value: { output, durationMs: 10 } satisfies SandboxResult,
      }),
    );
    const provider = createExecuteCodeProvider(stack);
    const result = await provider.attach({} as Parameters<typeof provider.attach>[0]);
    const map = result as ReadonlyMap<string, unknown>;
    const tool = map.get("tool:execute_code") as Tool;

    const res = (await tool.execute({ code: "test" })) as { readonly output: string };

    expect(res.output).toBe(output);
  });
});
