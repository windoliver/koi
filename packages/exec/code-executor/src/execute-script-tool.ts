import type { JsonObject, SandboxExecutor, Tool, ToolDescriptor } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { executeScript } from "./execute-script.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;

export interface ExecuteScriptToolConfig {
  readonly executor: SandboxExecutor;
}

const DESCRIPTION = [
  "Execute a JavaScript or TypeScript script in a sandboxed subprocess.",
  "Use this when you need to compute or transform data in one step instead of",
  "calling many tools sequentially across multiple model turns.",
  "",
  "Script contract:",
  "- The script body runs as the body of `async function (input) { ... }`.",
  "- Use `return <value>` to send a result back; the value must be JSON-serialisable.",
  "- `await` is allowed; top-level await is unnecessary (the wrapper is async).",
  "- Tool calls from inside the script are NOT supported — emit a separate tool call instead.",
  "",
  "The result always includes: ok (boolean), result (return value, when ok),",
  "durationMs, and error (with code and message, when not ok).",
].join("\n");

const INPUT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description: "Script source code",
    },
    language: {
      type: "string",
      enum: ["javascript", "typescript"],
      description: 'Script language — "javascript" or "typescript" (default: "javascript")',
    },
    timeout_ms: {
      type: "number",
      description: `Execution timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS})`,
    },
  },
  required: ["code"],
};

function clampTimeout(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(raw, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

export function createExecuteScriptTool(config: ExecuteScriptToolConfig): Tool {
  const descriptor: ToolDescriptor = {
    name: "execute_script",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    origin: "primordial",
  };

  return {
    descriptor,
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const code = typeof args.code === "string" ? args.code : undefined;
      if (code === undefined) {
        return {
          ok: false,
          error: { code: "VALIDATION", message: "code is required and must be a string" },
        };
      }

      const languageRaw = typeof args.language === "string" ? args.language : "javascript";
      if (languageRaw !== "javascript" && languageRaw !== "typescript") {
        return {
          ok: false,
          error: { code: "VALIDATION", message: `Unsupported language: ${languageRaw}` },
        };
      }

      return executeScript({
        code,
        language: languageRaw,
        timeoutMs: clampTimeout(args.timeout_ms),
        executor: config.executor,
      });
    },
  };
}
