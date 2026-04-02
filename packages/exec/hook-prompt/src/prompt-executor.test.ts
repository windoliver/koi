import { describe, expect, mock, test } from "bun:test";
import type { HookEvent, PromptHookConfig } from "@koi/core";
import { createPromptExecutor } from "./prompt-executor.js";
import type { PromptModelCaller, PromptModelRequest } from "./prompt-executor.js";

function makeEvent(overrides?: Partial<HookEvent>): HookEvent {
  return {
    kind: "beforeToolCall",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<PromptHookConfig>): PromptHookConfig {
  return {
    kind: "prompt",
    name: "test-hook",
    prompt: "Is this action safe?",
    ...overrides,
  };
}

function makeCaller(text: string): PromptModelCaller {
  return {
    complete: mock(() => Promise.resolve({ text })),
  };
}

describe("createPromptExecutor", () => {
  test("returns continue verdict when model approves", async () => {
    const caller = makeCaller('{ "ok": true, "reason": "Safe" }');
    const executor = createPromptExecutor(caller);

    const result = await executor.execute(makeConfig(), makeEvent());

    expect(result.kind).toBe("continue");
  });

  test("returns block verdict when model rejects", async () => {
    const caller = makeCaller('{ "ok": false, "reason": "Dangerous" }');
    const executor = createPromptExecutor(caller);

    const result = await executor.execute(makeConfig(), makeEvent());

    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.reason).toBe("Dangerous");
    }
  });

  test("returns block on error with default failMode (closed)", async () => {
    const caller: PromptModelCaller = {
      complete: mock(() => Promise.reject(new Error("timeout"))),
    };
    const executor = createPromptExecutor(caller);

    const result = await executor.execute(makeConfig(), makeEvent());

    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.reason).toContain("fail-closed");
      expect(result.reason).toContain("timeout");
    }
  });

  test("returns continue on error with failMode open", async () => {
    const caller: PromptModelCaller = {
      complete: mock(() => Promise.reject(new Error("timeout"))),
    };
    const executor = createPromptExecutor(caller);

    const result = await executor.execute(makeConfig({ failMode: "open" }), makeEvent());

    expect(result.kind).toBe("continue");
  });

  test("uses default model and maxTokens when not specified", async () => {
    let capturedRequest: PromptModelRequest | undefined;
    const caller: PromptModelCaller = {
      complete: mock((req: PromptModelRequest) => {
        capturedRequest = req;
        return Promise.resolve({ text: '{ "ok": true }' });
      }),
    };
    const executor = createPromptExecutor(caller);

    await executor.execute(makeConfig(), makeEvent());

    if (capturedRequest === undefined) {
      throw new Error("Expected capturedRequest to be defined");
    }
    expect(capturedRequest.model).toBe("haiku");
    expect(capturedRequest.maxTokens).toBe(256);
    expect(capturedRequest.timeoutMs).toBe(10_000);
  });

  test("uses configured model and maxTokens when specified", async () => {
    let capturedRequest: PromptModelRequest | undefined;
    const caller: PromptModelCaller = {
      complete: mock((req: PromptModelRequest) => {
        capturedRequest = req;
        return Promise.resolve({ text: '{ "ok": true }' });
      }),
    };
    const executor = createPromptExecutor(caller);

    await executor.execute(
      makeConfig({ model: "sonnet", maxTokens: 128, timeoutMs: 5_000 }),
      makeEvent(),
    );

    if (capturedRequest === undefined) {
      throw new Error("Expected capturedRequest to be defined");
    }
    expect(capturedRequest.model).toBe("sonnet");
    expect(capturedRequest.maxTokens).toBe(128);
    expect(capturedRequest.timeoutMs).toBe(5_000);
  });

  test("includes toolName and data in user prompt", async () => {
    let capturedRequest: PromptModelRequest | undefined;
    const caller: PromptModelCaller = {
      complete: mock((req: PromptModelRequest) => {
        capturedRequest = req;
        return Promise.resolve({ text: '{ "ok": true }' });
      }),
    };
    const executor = createPromptExecutor(caller);

    await executor.execute(
      makeConfig(),
      makeEvent({ toolName: "shell", data: { cmd: "rm -rf /" } }),
    );

    if (capturedRequest === undefined) {
      throw new Error("Expected capturedRequest to be defined");
    }
    expect(capturedRequest.userPrompt).toContain("shell");
    expect(capturedRequest.userPrompt).toContain("rm -rf /");
  });

  test("executor kind is prompt", () => {
    const executor = createPromptExecutor(makeCaller("ok"));
    expect(executor.kind).toBe("prompt");
  });
});
