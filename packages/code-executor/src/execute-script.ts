/**
 * Script executor — orchestrates transpilation, bridges, and sandbox execution.
 *
 * This is the main entry point for running user scripts in Code Mode.
 * It composes the console bridge, tool bridge, and async Wasm executor.
 */

import type { Tool } from "@koi/core";
import { createAsyncWasmExecutor } from "@koi/sandbox-wasm";
import type { ConsoleEntry } from "./console-bridge.js";
import { createConsoleBridge } from "./console-bridge.js";
import { createToolBridge } from "./tool-bridge.js";
import { transpileTs } from "./transpile.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScriptConfig {
  /** The script source code to execute. */
  readonly code: string;
  /** Script language: "javascript" or "typescript". Default: "javascript". */
  readonly language?: "javascript" | "typescript";
  /** Execution timeout in milliseconds. Default: 30_000. */
  readonly timeoutMs?: number;
  /** Maximum tool calls per execution. Default: 50. */
  readonly maxToolCalls?: number;
  /** Available tools for the script to call via `callTool()`. */
  readonly tools: ReadonlyMap<string, Tool>;
}

export interface ScriptResult {
  readonly ok: boolean;
  readonly result: unknown;
  readonly console: readonly ConsoleEntry[];
  readonly toolCallCount: number;
  readonly durationMs: number;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOOL_CALLS = 50;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function executeScript(config: ScriptConfig): Promise<ScriptResult> {
  const {
    code,
    language = "javascript",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
    tools,
  } = config;

  return executeScriptInternal(code, language, timeoutMs, maxToolCalls, tools);
}

// ---------------------------------------------------------------------------
// Internal (extracted to keep executeScript < 50 lines)
// ---------------------------------------------------------------------------

async function executeScriptInternal(
  code: string,
  language: "javascript" | "typescript",
  timeoutMs: number,
  maxToolCalls: number,
  tools: ReadonlyMap<string, Tool>,
): Promise<ScriptResult> {
  const start = performance.now();

  // Step 1: Transpile TypeScript if needed.
  // Justified `let`: may be reassigned after transpilation.
  let jsCode = code;
  if (language === "typescript") {
    const transpiled = transpileTs(code);
    if (!transpiled.ok) {
      return {
        ok: false,
        result: undefined,
        console: [],
        toolCallCount: 0,
        durationMs: performance.now() - start,
        error: transpiled.error,
      };
    }
    jsCode = transpiled.code;
  }

  // Step 2: Create bridges.
  const consoleBridge = createConsoleBridge();
  const toolBridge = createToolBridge({ tools, maxCalls: maxToolCalls });

  // Step 3: Merge host functions.
  const hostFunctions = new Map<string, (argsJson: string) => Promise<string>>([
    ...consoleBridge.hostFunctions,
    ...toolBridge.hostFunctions,
  ]);

  // Step 4: Build full script with preambles.
  const fullScript = `${consoleBridge.preamble}\n${toolBridge.preamble}\n${jsCode}`;

  // Step 5: Execute in sandbox.
  const executor = createAsyncWasmExecutor();
  const execResult = await executor.execute(fullScript, undefined, timeoutMs, hostFunctions);

  // Step 6: Map result.
  const durationMs = performance.now() - start;
  const consoleEntries = consoleBridge.entries();
  const toolCallCount = toolBridge.callCount();

  if (!execResult.ok) {
    return {
      ok: false,
      result: undefined,
      console: consoleEntries,
      toolCallCount,
      durationMs,
      error: execResult.error.message,
    };
  }

  return {
    ok: true,
    result: execResult.value.output,
    console: consoleEntries,
    toolCallCount,
    durationMs,
  };
}
