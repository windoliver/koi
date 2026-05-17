import { describe, expect, test } from "bun:test";
import type { Agent, SandboxExecutor, Tool } from "@koi/core";
import { COMPONENT_PRIORITY, toolToken } from "@koi/core";
import { createCodeExecutorProvider } from "./provider.js";

function noopExecutor(): SandboxExecutor {
  return {
    execute: async () => ({ ok: true, value: { output: undefined, durationMs: 0 } }),
  };
}

const STUB_AGENT = {} as Agent;

describe("createCodeExecutorProvider", () => {
  test("attaches execute_script tool under toolToken('execute_script')", async () => {
    const provider = createCodeExecutorProvider({ executor: noopExecutor() });
    const result = await provider.attach(STUB_AGENT);
    const components =
      result instanceof Map
        ? result
        : (result as { readonly components: ReadonlyMap<string, unknown> }).components;
    const tool = components.get(toolToken("execute_script") as string) as Tool | undefined;
    expect(tool).toBeDefined();
    expect(tool?.descriptor.name).toBe("execute_script");
  });

  test("default priority is COMPONENT_PRIORITY.BUNDLED", () => {
    const provider = createCodeExecutorProvider({ executor: noopExecutor() });
    expect(provider.priority).toBe(COMPONENT_PRIORITY.BUNDLED);
  });

  test("respects caller-supplied priority override", () => {
    const provider = createCodeExecutorProvider({ executor: noopExecutor(), priority: 5 });
    expect(provider.priority).toBe(5);
  });

  test("provider name is 'code-executor'", () => {
    const provider = createCodeExecutorProvider({ executor: noopExecutor() });
    expect(provider.name).toBe("code-executor");
  });

  test("threads workspacePath into execute_script context", async () => {
    const captured: unknown[][] = [];
    const provider = createCodeExecutorProvider({
      workspacePath: "/work/repo",
      executor: {
        execute: async (code, input, timeoutMs, context) => {
          captured.push([code, input, timeoutMs, context]);
          return { ok: true, value: { output: undefined, durationMs: 0 } };
        },
      },
    });
    const result = await provider.attach(STUB_AGENT);
    const components =
      result instanceof Map
        ? result
        : (result as { readonly components: ReadonlyMap<string, unknown> }).components;
    const tool = components.get(toolToken("execute_script") as string) as Tool;

    await tool.execute({ code: "return 1;" });

    expect(captured[0]?.[3]).toMatchObject({ workspacePath: "/work/repo" });
  });
});
