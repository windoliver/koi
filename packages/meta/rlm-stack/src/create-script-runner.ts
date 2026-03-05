/**
 * Script runner adapter — bridges @koi/middleware-rlm's RlmScriptRunner
 * interface to @koi/code-executor's executeScript function.
 *
 * Wraps each host function into a minimal Tool object that executeScript
 * expects, then maps the ScriptResult back to RlmScriptResult.
 */

import { executeScript } from "@koi/code-executor";
import type { JsonObject, Tool, ToolDescriptor } from "@koi/core";
import type { RlmScriptResult, RlmScriptRunConfig, RlmScriptRunner } from "@koi/middleware-rlm";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CALLS = 100;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ScriptRunnerConfig {
  /** Default timeout per execution in milliseconds. Default: 30_000. */
  readonly timeoutMs?: number | undefined;
  /** Default maximum tool calls per execution. Default: 100. */
  readonly maxCalls?: number | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_SCHEMA: JsonObject = { type: "object" };

/** Create a minimal ToolDescriptor for a host function. */
function createStubDescriptor(name: string): ToolDescriptor {
  return {
    name,
    description: `RLM host function: ${name}`,
    inputSchema: STUB_SCHEMA,
  };
}

/** Wrap a host function into a Tool object for executeScript. */
function wrapHostFn(name: string, fn: (args: JsonObject) => Promise<unknown> | unknown): Tool {
  return {
    descriptor: createStubDescriptor(name),
    trustTier: "sandbox",
    execute: async (args: JsonObject): Promise<unknown> => fn(args),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates an RlmScriptRunner backed by @koi/code-executor's executeScript.
 *
 * Each call wraps the provided host functions into Tool objects and executes
 * the code in a QuickJS WASM sandbox.
 */
export function createScriptRunner(config?: ScriptRunnerConfig): RlmScriptRunner {
  const defaultTimeout = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultMaxCalls = config?.maxCalls ?? DEFAULT_MAX_CALLS;

  return {
    run: async (runConfig: RlmScriptRunConfig): Promise<RlmScriptResult> => {
      const tools = new Map<string, Tool>();
      for (const [name, fn] of runConfig.hostFns) {
        tools.set(name, wrapHostFn(name, fn));
      }

      const result = await executeScript({
        code: runConfig.code,
        language: "javascript",
        timeoutMs: runConfig.timeoutMs ?? defaultTimeout,
        maxToolCalls: runConfig.maxCalls ?? defaultMaxCalls,
        tools,
      });

      return {
        ok: result.ok,
        console: result.console.map((entry) => entry.message),
        result: result.result,
        error: result.error,
        callCount: result.toolCallCount,
      };
    },
  };
}
