/**
 * `execute_script` tool — runs a script in the Wasm sandbox.
 *
 * The script can call other tools via `callTool(name, args)`.
 * TypeScript is supported and transpiled automatically.
 *
 * All errors (transpilation, timeout, OOM, tool call failures, script throws)
 * are returned in the result with `ok: false` — never thrown.
 */

import type { JsonObject, Tool, ToolDescriptor } from "@koi/core";
import type { ScriptResult } from "./execute-script.js";
import { executeScript } from "./execute-script.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createExecuteScriptTool(tools: ReadonlyMap<string, Tool>): Tool {
  const descriptor: ToolDescriptor = {
    name: "execute_script",
    description: [
      "Execute a JavaScript or TypeScript script in a sandboxed environment.",
      "Use this when you need to perform multiple tool calls in a single step",
      "instead of calling each tool one at a time.",
      "",
      "API available inside the script:",
      "- callTool(name, args) — call any tool by name. Synchronous, returns the result directly.",
      '  All tools you can see are callable by name (e.g. callTool("file_read", { path: "/foo" })).',
      "- console.log(), console.error(), console.warn() — captured and returned in the result.",
      "- The last expression value becomes the result.",
      "",
      "Constraints:",
      "- Tools must be called sequentially — no Promise.all() or concurrent calls.",
      "- Use var for top-level variables (the sandbox is ES5).",
      "- If callTool fails (unknown tool, tool error, budget exceeded), it throws.",
      "  Wrap in try/catch to handle gracefully, otherwise the script stops.",
      "",
      "The result always includes: ok (boolean), result (last expression or undefined),",
      "console (captured output), toolCallCount, durationMs, and error (string, if failed).",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The script source code to execute",
        },
        language: {
          type: "string",
          description: 'Script language: "javascript" or "typescript" (default: "javascript")',
        },
        timeout_ms: {
          type: "number",
          description: `Execution timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS})`,
        },
      },
      required: ["code"],
    } as JsonObject,
  };

  return {
    descriptor,
    trustTier: "sandbox",
    execute: async (args: JsonObject): Promise<unknown> => {
      const code = typeof args.code === "string" ? args.code : undefined;
      if (code === undefined) {
        return { ok: false, error: "code is required and must be a string" };
      }

      const languageRaw = typeof args.language === "string" ? args.language : "javascript";
      if (languageRaw !== "javascript" && languageRaw !== "typescript") {
        return { ok: false, error: `Unsupported language: ${languageRaw}` };
      }

      const timeoutRaw = typeof args.timeout_ms === "number" ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
      const timeoutMs = Math.min(Math.max(timeoutRaw, 100), MAX_TIMEOUT_MS);

      const result: ScriptResult = await executeScript({
        code,
        language: languageRaw,
        timeoutMs,
        tools,
      });

      return result;
    },
  };
}
