/**
 * Tool bridge for the sandbox.
 *
 * Creates an async host function `__callToolRaw` that receives a JSON-encoded
 * `{ name, args }` payload, looks up the tool, calls `tool.execute(args)`, and
 * returns the JSON-encoded result.
 *
 * Guest code calls `callTool(name, args)` which is defined in the JS preamble.
 * Asyncified host functions appear synchronous to the guest.
 */

import type { JsonObject, Tool } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolBridgeConfig {
  /** Map of tool name → Tool implementation. */
  readonly tools: ReadonlyMap<string, Tool>;
  /** Maximum number of tool calls per script execution. Default: 50. */
  readonly maxCalls?: number;
}

export interface ToolBridge {
  /** JS preamble defining the user-facing `callTool(name, args)` function. */
  readonly preamble: string;
  /** Host functions to register with the async executor. */
  readonly hostFunctions: ReadonlyMap<string, (argsJson: string) => Promise<string>>;
  /** Number of tool calls made so far. */
  readonly callCount: () => number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CALLS = 50;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createToolBridge(config: ToolBridgeConfig): ToolBridge {
  const { tools, maxCalls = DEFAULT_MAX_CALLS } = config;

  // Justified `let`: counter incremented on each tool call.
  let calls = 0;

  const hostFunctions = new Map<string, (argsJson: string) => Promise<string>>([
    [
      "__callToolRaw",
      async (argsJson: string): Promise<string> => {
        calls++;
        if (calls > maxCalls) {
          return JSON.stringify({ __error: `Tool call budget exceeded (max ${maxCalls})` });
        }

        // Justified `let`: parsed may fail, need separate error path.
        let parsed: { readonly name?: unknown; readonly args?: unknown };
        try {
          parsed = JSON.parse(argsJson) as { readonly name?: unknown; readonly args?: unknown };
        } catch (_e: unknown) {
          return JSON.stringify({ __error: "Invalid JSON in tool call arguments" });
        }

        const name = typeof parsed.name === "string" ? parsed.name : undefined;
        if (name === undefined) {
          return JSON.stringify({ __error: "Tool name must be a string" });
        }

        const tool = tools.get(name);
        if (tool === undefined) {
          return JSON.stringify({ __error: `Unknown tool: ${name}` });
        }

        const args = (
          typeof parsed.args === "object" && parsed.args !== null ? parsed.args : {}
        ) as JsonObject;

        try {
          const result = await tool.execute(args);
          return JSON.stringify(result);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : "Tool execution failed";
          return JSON.stringify({ __error: message });
        }
      },
    ],
  ]);

  const preamble = `function callTool(name, args) {
  var payload = JSON.stringify({ name: name, args: args || {} });
  var raw = __callToolRaw(payload);
  var result = JSON.parse(raw);
  if (result && result.__error) {
    throw new Error(result.__error);
  }
  return result;
}`;

  return {
    preamble,
    hostFunctions,
    callCount: () => calls,
  };
}
