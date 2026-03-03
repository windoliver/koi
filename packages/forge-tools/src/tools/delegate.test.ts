import { describe, expect, test } from "bun:test";
import type { ExternalAgentDescriptor, KoiError, Result } from "@koi/core";
import type { ForgeToolInput } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import { createInMemoryForgeStore } from "../memory-store.js";
import { delegateImplementation, generateDelegationPrompt } from "./delegate.js";
import type { DelegateOptions, ForgeDeps } from "./shared.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const MOCK_AGENT: ExternalAgentDescriptor = {
  name: "claude-code",
  transport: "cli",
  capabilities: ["code-generation"],
  source: "path",
};

function createToolInput(overrides?: Partial<ForgeToolInput>): ForgeToolInput {
  return {
    kind: "tool",
    name: "calc",
    description: "A calculator tool",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
    implementation: "",
    ...overrides,
  };
}

function createDelegationDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  return {
    store: createInMemoryForgeStore(),
    executor: {
      execute: async () => ({ ok: true, value: { output: null, durationMs: 0 } }),
    },
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: { agentId: "test-agent", depth: 0, sessionId: "test-session", forgesThisSession: 0 },
    ...overrides,
  };
}

function mockDiscoverAgent(
  result: Result<ExternalAgentDescriptor, KoiError>,
): (name: string) => Promise<Result<ExternalAgentDescriptor, KoiError>> {
  return async () => result;
}

function mockSpawnCodingAgent(
  result: Result<string, KoiError>,
): (
  agent: ExternalAgentDescriptor,
  prompt: string,
  options: DelegateOptions,
) => Promise<Result<string, KoiError>> {
  return async () => result;
}

function mockSpawnSequence(
  results: readonly Result<string, KoiError>[],
): (
  agent: ExternalAgentDescriptor,
  prompt: string,
  options: DelegateOptions,
) => Promise<Result<string, KoiError>> {
  // let justified: mutable index to track which result to return next
  let callIndex = 0;
  return async () => {
    const lastIndex = results.length - 1;
    const idx = callIndex <= lastIndex ? callIndex : lastIndex;
    const result = results[idx];
    callIndex++;
    if (result === undefined) {
      return { ok: false, error: { code: "INTERNAL", message: "No results", retryable: false } };
    }
    return result;
  };
}

const FOUND_AGENT: Result<ExternalAgentDescriptor, KoiError> = {
  ok: true,
  value: MOCK_AGENT,
};

const SPAWN_SUCCESS: Result<string, KoiError> = {
  ok: true,
  value: "return input.a + input.b;",
};

// ---------------------------------------------------------------------------
// generateDelegationPrompt
// ---------------------------------------------------------------------------

describe("generateDelegationPrompt", () => {
  test("includes tool name and description", () => {
    const input = createToolInput();
    const prompt = generateDelegationPrompt(input);
    expect(prompt).toContain('"calc"');
    expect(prompt).toContain("A calculator tool");
  });

  test("includes input schema", () => {
    const input = createToolInput();
    const prompt = generateDelegationPrompt(input);
    expect(prompt).toContain('"type": "object"');
    expect(prompt).toContain('"a"');
  });

  test("includes test cases when provided", () => {
    const input = createToolInput({
      testCases: [
        { name: "adds numbers", input: { a: 1, b: 2 }, expectedOutput: 3 },
        { name: "handles zero", input: { a: 0, b: 5 } },
      ],
    });
    const prompt = generateDelegationPrompt(input);
    expect(prompt).toContain("adds numbers");
    expect(prompt).toContain("handles zero");
    expect(prompt).toContain("expected=3");
  });

  test("includes output schema when provided", () => {
    const input = createToolInput({
      outputSchema: { type: "number" },
    });
    const prompt = generateDelegationPrompt(input);
    expect(prompt).toContain("Output schema");
    expect(prompt).toContain('"type": "number"');
  });

  test("omits test cases section when none provided", () => {
    const input = createToolInput();
    const prompt = generateDelegationPrompt(input);
    expect(prompt).not.toContain("Test cases");
  });
});

// ---------------------------------------------------------------------------
// delegateImplementation
// ---------------------------------------------------------------------------

describe("delegateImplementation", () => {
  test("returns implementation on happy path", async () => {
    const deps = createDelegationDeps({
      discoverAgent: mockDiscoverAgent(FOUND_AGENT),
      spawnCodingAgent: mockSpawnCodingAgent(SPAWN_SUCCESS),
    });

    const result = await delegateImplementation("claude-code", createToolInput(), deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("return input.a + input.b;");
    }
  });

  test("returns AGENT_NOT_FOUND when agent not discovered", async () => {
    const deps = createDelegationDeps({
      discoverAgent: mockDiscoverAgent({
        ok: false,
        error: { code: "NOT_FOUND", message: "No such agent", retryable: false },
      }),
      spawnCodingAgent: mockSpawnCodingAgent(SPAWN_SUCCESS),
    });

    const result = await delegateImplementation("nonexistent", createToolInput(), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("delegation");
      expect(result.error).toHaveProperty("code", "AGENT_NOT_FOUND");
      expect(result.error.message).toContain("nonexistent");
    }
  });

  test("returns DELEGATION_TIMEOUT when spawn times out", async () => {
    const deps = createDelegationDeps({
      discoverAgent: mockDiscoverAgent(FOUND_AGENT),
      spawnCodingAgent: mockSpawnCodingAgent({
        ok: false,
        error: { code: "TIMEOUT", message: "Agent timed out after 120s", retryable: true },
      }),
    });

    const result = await delegateImplementation("claude-code", createToolInput(), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("delegation");
      expect(result.error).toHaveProperty("code", "DELEGATION_TIMEOUT");
    }
  });

  test("returns DELEGATION_FAILED when spawn fails with non-timeout error", async () => {
    const deps = createDelegationDeps({
      discoverAgent: mockDiscoverAgent(FOUND_AGENT),
      spawnCodingAgent: mockSpawnCodingAgent({
        ok: false,
        error: { code: "INTERNAL", message: "Process crashed", retryable: false },
      }),
    });

    const result = await delegateImplementation("claude-code", createToolInput(), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("delegation");
      expect(result.error).toHaveProperty("code", "DELEGATION_FAILED");
    }
  });

  test("retries and succeeds on second attempt", async () => {
    const deps = createDelegationDeps({
      discoverAgent: mockDiscoverAgent(FOUND_AGENT),
      spawnCodingAgent: mockSpawnSequence([
        {
          ok: false,
          error: { code: "INTERNAL", message: "Transient failure", retryable: true },
        },
        SPAWN_SUCCESS,
      ]),
    });

    const result = await delegateImplementation("claude-code", createToolInput(), deps, {
      retries: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("return input.a + input.b;");
    }
  });

  test("returns DELEGATION_RETRIES_EXHAUSTED after all retries fail", async () => {
    const failure: Result<string, KoiError> = {
      ok: false,
      error: { code: "INTERNAL", message: "Keeps failing", retryable: false },
    };
    const deps = createDelegationDeps({
      discoverAgent: mockDiscoverAgent(FOUND_AGENT),
      spawnCodingAgent: mockSpawnSequence([failure, failure, failure]),
    });

    const result = await delegateImplementation("claude-code", createToolInput(), deps, {
      retries: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("delegation");
      expect(result.error).toHaveProperty("code", "DELEGATION_RETRIES_EXHAUSTED");
      expect(result.error.message).toContain("3 delegation attempts");
    }
  });

  test("returns DELEGATION_FAILED when deps callbacks are missing", async () => {
    const deps = createDelegationDeps();

    const result = await delegateImplementation("claude-code", createToolInput(), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("delegation");
      expect(result.error).toHaveProperty("code", "DELEGATION_FAILED");
      expect(result.error.message).toContain("discoverAgent");
      expect(result.error.message).toContain("spawnCodingAgent");
    }
  });

  test("passes delegate options to spawnCodingAgent", async () => {
    // let justified: capture to verify options were forwarded
    let capturedOptions: DelegateOptions | undefined;
    const deps = createDelegationDeps({
      discoverAgent: mockDiscoverAgent(FOUND_AGENT),
      spawnCodingAgent: async (
        _agent: ExternalAgentDescriptor,
        _prompt: string,
        opts: DelegateOptions,
      ) => {
        capturedOptions = opts;
        return SPAWN_SUCCESS;
      },
    });

    await delegateImplementation("claude-code", createToolInput(), deps, {
      model: "opus",
      timeoutMs: 60_000,
    });

    expect(capturedOptions).toBeDefined();
    if (capturedOptions !== undefined) {
      expect(capturedOptions.model).toBe("opus");
      expect(capturedOptions.timeoutMs).toBe(60_000);
    }
  });
});
