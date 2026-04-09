import { describe, expect, mock, test } from "bun:test";
import type { HookEvent, PromptHookConfig } from "@koi/core";
import type { PromptModelCaller, PromptModelRequest } from "@koi/hook-prompt";
import { PromptExecutorAdapter } from "./prompt-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides?: Partial<HookEvent>): HookEvent {
  return {
    event: "tool.before",
    agentId: "test-agent",
    sessionId: "test-session",
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<PromptHookConfig>): PromptHookConfig {
  return {
    kind: "prompt",
    name: "test-prompt-hook",
    prompt: "Is this action safe?",
    ...overrides,
  };
}

function makeCaller(text: string): PromptModelCaller {
  return {
    complete: mock(() => Promise.resolve({ text })),
  };
}

function makeFailingCaller(error: Error): PromptModelCaller {
  return {
    complete: mock(() => Promise.reject(error)),
  };
}

function makeAdapter(caller: PromptModelCaller): PromptExecutorAdapter {
  return new PromptExecutorAdapter({ caller });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PromptExecutorAdapter", () => {
  test("canHandle returns true for prompt hooks", () => {
    const adapter = makeAdapter(makeCaller("ok"));
    expect(adapter.canHandle(makeConfig())).toBe(true);
  });

  test("canHandle returns false for non-prompt hooks", () => {
    const adapter = makeAdapter(makeCaller("ok"));
    expect(adapter.canHandle({ kind: "command", name: "cmd", cmd: ["echo"] })).toBe(false);
  });

  test("name is 'prompt'", () => {
    const adapter = makeAdapter(makeCaller("ok"));
    expect(adapter.name).toBe("prompt");
  });

  // ── Happy path ──

  test("ok:true response returns continue decision", async () => {
    const adapter = makeAdapter(makeCaller('{ "ok": true, "reason": "Safe" }'));
    const result = await adapter.execute(makeConfig(), makeEvent(), AbortSignal.timeout(5_000));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.kind).toBe("continue");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("ok:false response returns block decision", async () => {
    const adapter = makeAdapter(makeCaller('{ "ok": false, "reason": "Dangerous command" }'));
    const result = await adapter.execute(makeConfig(), makeEvent(), AbortSignal.timeout(5_000));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.kind).toBe("block");
      if (result.decision.kind === "block") {
        expect(result.decision.reason).toBe("Dangerous command");
      }
    }
  });

  // ── Error handling ──

  test("caller error with failClosed:true returns block decision", async () => {
    const adapter = makeAdapter(makeFailingCaller(new Error("timeout")));
    const result = await adapter.execute(
      makeConfig({ failClosed: true }),
      makeEvent(),
      AbortSignal.timeout(5_000),
    );

    // The inner executor catches the error and returns a block decision
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.kind).toBe("block");
      if (result.decision.kind === "block") {
        expect(result.decision.reason).toContain("fail-closed");
        expect(result.decision.reason).toContain("timeout");
      }
    }
  });

  test("caller error with failClosed:false returns continue", async () => {
    const adapter = makeAdapter(makeFailingCaller(new Error("timeout")));
    const result = await adapter.execute(
      makeConfig({ failClosed: false }),
      makeEvent(),
      AbortSignal.timeout(5_000),
    );

    // The inner executor swallows the error and returns continue when failClosed:false
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.kind).toBe("continue");
    }
  });

  test("malformed model output with failClosed:true blocks", async () => {
    const adapter = makeAdapter(makeCaller("this is not json at all"));
    const result = await adapter.execute(
      makeConfig({ failClosed: true }),
      makeEvent(),
      AbortSignal.timeout(5_000),
    );

    // The hardened verdict parser may detect denial language or throw VerdictParseError
    // Either way, the result should not be a silent continue
    if (result.ok && result.decision.kind === "continue") {
      // If it parsed as continue, executionFailed must be set
      expect(result.executionFailed).toBe(true);
    }
    // Otherwise it's a block or error — both are acceptable fail-closed behavior
  });

  // ── Abort handling ──

  test("already-aborted signal returns aborted result", async () => {
    const adapter = makeAdapter(makeCaller('{ "ok": true }'));
    const controller = new AbortController();
    controller.abort();

    const result = await adapter.execute(makeConfig(), makeEvent(), controller.signal);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("aborted");
      expect(result.aborted).toBe(true);
    }
  });

  // ── Duration measurement ──

  test("durationMs is always populated", async () => {
    const adapter = makeAdapter(makeCaller('{ "ok": true }'));
    const result = await adapter.execute(makeConfig(), makeEvent(), AbortSignal.timeout(5_000));

    if (result.ok) {
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } else {
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  // ── Token budget ──

  test("exhausted budget blocks with error", async () => {
    const adapter = makeAdapter(makeCaller('{ "ok": true }'));
    const signal = AbortSignal.timeout(5_000);
    const event = makeEvent({ sessionId: "budget-session" });
    const config = makeConfig({ maxTokens: 30_000 });

    // First call consumes 30_000 tokens (within 50_000 budget)
    const r1 = await adapter.execute(config, event, signal);
    expect(r1.ok).toBe(true);

    // Second call would need 30_000 more (total 60_000 > 50_000 budget)
    const r2 = await adapter.execute(config, event, signal);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error).toContain("budget exhausted");
    }
  });

  test("cleanupSession resets budget", async () => {
    const adapter = makeAdapter(makeCaller('{ "ok": true }'));
    const signal = AbortSignal.timeout(5_000);
    const event = makeEvent({ sessionId: "cleanup-session" });
    const config = makeConfig({ maxTokens: 30_000 });

    await adapter.execute(config, event, signal);
    adapter.cleanupSession("cleanup-session");

    // After cleanup, budget is fresh
    const r2 = await adapter.execute(config, event, signal);
    expect(r2.ok).toBe(true);
  });

  // ── Event data capping ──

  test("large event data is truncated", async () => {
    let capturedRequest: PromptModelRequest | undefined;
    const caller: PromptModelCaller = {
      complete: mock((req: PromptModelRequest) => {
        capturedRequest = req;
        return Promise.resolve({ text: '{ "ok": true }' });
      }),
    };
    const adapter = makeAdapter(caller);

    // Create event with large data (>32KB)
    const largeData = { payload: "x".repeat(40_000) };
    const event = makeEvent({ data: largeData });

    await adapter.execute(makeConfig(), event, AbortSignal.timeout(5_000));

    expect(capturedRequest).toBeDefined();
    if (capturedRequest !== undefined) {
      // The user prompt should contain truncation markers
      expect(capturedRequest.userPrompt).toContain("truncat");
    }
  });

  // ── Non-prompt hook rejection ──

  test("non-prompt hook returns error", async () => {
    const adapter = makeAdapter(makeCaller("ok"));
    const result = await adapter.execute(
      { kind: "command", name: "cmd", cmd: ["echo"] } as unknown as PromptHookConfig,
      makeEvent(),
      AbortSignal.timeout(5_000),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Not a prompt hook");
    }
  });

  // ── Model/maxTokens threading ──

  test("threads model and maxTokens to caller", async () => {
    let capturedRequest: PromptModelRequest | undefined;
    const caller: PromptModelCaller = {
      complete: mock((req: PromptModelRequest) => {
        capturedRequest = req;
        return Promise.resolve({ text: '{ "ok": true }' });
      }),
    };
    const adapter = makeAdapter(caller);

    await adapter.execute(
      makeConfig({ model: "sonnet", maxTokens: 128 }),
      makeEvent(),
      AbortSignal.timeout(5_000),
    );

    expect(capturedRequest).toBeDefined();
    if (capturedRequest !== undefined) {
      expect(capturedRequest.model).toBe("sonnet");
      expect(capturedRequest.maxTokens).toBe(128);
    }
  });
});
