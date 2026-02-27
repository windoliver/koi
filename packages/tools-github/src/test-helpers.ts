/**
 * Shared test helpers for @koi/tools-github tests.
 *
 * Test convention — each tool test file MUST cover:
 *   1. Happy path (success case)
 *   2. Missing required arg (VALIDATION error)
 *   3. Invalid arg type (VALIDATION error)
 *   4. Tool-specific failure mode (executor error)
 */

import type { Agent, KoiError, KoiErrorCode, Result, SubsystemToken } from "@koi/core";
import { agentId } from "@koi/core";
import type { GhExecuteOptions, GhExecutor } from "./gh-executor.js";

/** A canned response entry for the mock executor. */
export interface MockGhResponse {
  readonly result: Result<string, KoiError>;
}

/**
 * Create a mock GhExecutor that returns canned responses in order.
 *
 * When all responses are consumed, returns an EXTERNAL error.
 * Also tracks call history for assertions on args passed.
 */
export function createMockGhExecutor(responses: readonly MockGhResponse[]): GhExecutor & {
  readonly calls: ReadonlyArray<{
    readonly args: readonly string[];
    readonly options: GhExecuteOptions | undefined;
  }>;
} {
  const calls: Array<{
    readonly args: readonly string[];
    readonly options: GhExecuteOptions | undefined;
  }> = [];
  // let is justified: index is incremented on each call to track consumption
  let callIndex = 0;

  return {
    calls,
    execute: async (
      args: readonly string[],
      options?: GhExecuteOptions,
    ): Promise<Result<string, KoiError>> => {
      calls.push({ args, options });
      const response = responses[callIndex];
      callIndex += 1;

      if (response === undefined) {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: "Mock executor: no more canned responses",
            retryable: false,
          },
        };
      }

      return response.result;
    },
  };
}

/** Shorthand to create a successful mock response with JSON output. */
export function mockSuccess(json: unknown): MockGhResponse {
  return { result: { ok: true, value: JSON.stringify(json) } };
}

/** Shorthand to create a successful mock response with raw string output. */
export function mockSuccessRaw(output: string): MockGhResponse {
  return { result: { ok: true, value: output } };
}

/** Shorthand to create a failed mock response. */
export function mockError(code: KoiErrorCode, message: string): MockGhResponse {
  return {
    result: {
      ok: false,
      error: { code, message, retryable: code === "RATE_LIMIT" },
    },
  };
}

/** Create a minimal mock Agent for testing. */
export function createMockAgent(): Agent {
  const components = new Map<string, unknown>();
  return {
    pid: { id: agentId("test-agent"), name: "test", type: "worker", depth: 0 },
    manifest: {
      name: "test-agent",
      version: "0.0.0",
      model: { name: "test-model" },
    },
    state: "running",
    component: <T>(token: { toString: () => string }): T | undefined =>
      components.get(token.toString()) as T | undefined,
    has: (token: { toString: () => string }): boolean => components.has(token.toString()),
    hasAll: (...tokens: readonly { toString: () => string }[]): boolean =>
      tokens.every((t) => components.has(t.toString())),
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: (): ReadonlyMap<string, unknown> => components,
  };
}
