import type { JsonObject, KoiError, Result, Tool, ToolExecuteOptions } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { buildTool } from "@koi/tools-core";
import { DEFAULT_TIMEOUT_MS, executeScript, MAX_TIMEOUT_MS } from "./execute-script.js";
import type { ScriptConfig } from "./types.js";

const EXECUTE_CODE_DESCRIPTION = `\
Run a TypeScript/JavaScript script that calls registered tools via \`tools.*\`.

Use this when you need to execute a multi-step pipeline where intermediate \
tool results do not need to appear in the conversation context — only the \
final return value of the script is returned.

The script receives a \`tools\` object with one async method per registered \
tool. Each method accepts the tool's normal arguments and returns its result.

Example:
\`\`\`typescript
const files = await tools.glob({ pattern: "**/*.ts" });
const hits = await tools.grep({ pattern: "TODO", glob: "**/*.ts" });
return { fileCount: files.length, todoCount: hits.length };
\`\`\`

Constraints:
- \`await\` every tool call (calls are async)
- Sequential calls only — \`Promise.all\` across tools is not supported
- The script may not import external modules
- Timeout defaults to ${DEFAULT_TIMEOUT_MS / 1000}s, max ${MAX_TIMEOUT_MS / 1000}s

Security note: the script runs in a Bun Worker thread and has access to the \
same ambient globals as the host process (fetch, timers, Bun file APIs). \
All privileged operations should use \`tools.*\` so that permission middleware \
applies — but the runtime does NOT prevent direct ambient API access. \
Use this tool only when you trust the generated script.`;

// Schema mirrors the runtime validation below — minLength on script and
// exclusiveMinimum on timeout_ms — so callers (and the model) cannot pass
// inputs that satisfy the schema yet still throw inside execute().
const EXECUTE_CODE_SCHEMA = {
  type: "object",
  properties: {
    script: {
      type: "string",
      minLength: 1,
      description:
        "TypeScript or JavaScript code. Use `await tools.toolName(args)` to call tools. The return value of the script is the final result.",
    },
    timeout_ms: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: MAX_TIMEOUT_MS,
      description: `Maximum execution time in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}. Maximum: ${MAX_TIMEOUT_MS}.`,
    },
  },
  required: ["script"],
} as const satisfies JsonObject;

/**
 * Sentinel value the caller must pass to acknowledge that scripts run with
 * the host process's ambient Bun capabilities (fetch, timers, Bun.file APIs).
 * The literal string is intentionally explicit so it stands out in code review
 * and grep results — it is NOT a default and CANNOT be defaulted.
 */
export const ACKNOWLEDGE_UNSANDBOXED_EXECUTION =
  "I-understand-this-tool-bypasses-the-permission-middleware" as const;

export interface ExecuteCodeToolConfig {
  /** Tools exposed to the script. */
  readonly tools: ReadonlyMap<string, Tool>;
  /**
   * Required trust gate. Scripts run in a Bun Worker that shares the host's
   * ambient network and filesystem capabilities; a script can call `fetch`,
   * `Bun.file`, etc. directly, bypassing any `tools.*` permission middleware.
   * Callers MUST pass `ACKNOWLEDGE_UNSANDBOXED_EXECUTION` to opt in. Without
   * this acknowledgement `createExecuteCodeTool` returns a VALIDATION error
   * — the tool is not constructed and cannot be invoked.
   */
  readonly acknowledgeUnsandboxedExecution: typeof ACKNOWLEDGE_UNSANDBOXED_EXECUTION;
  /**
   * Optional middleware-aware call function injected by L3 runtime.
   * When provided, inner tool calls go through the full permission and
   * middleware chain. Falls back to direct tool.execute() when absent.
   */
  readonly callTool?: ScriptConfig["callTool"];
  /** Default timeout override (ms). Default: 30 000. */
  readonly defaultTimeoutMs?: number;
}

/**
 * Create the `execute_code` tool.
 *
 * Returns Result<Tool> so callers can handle validation errors without throws.
 */
export function createExecuteCodeTool(config: ExecuteCodeToolConfig): Result<Tool, KoiError> {
  // Trust gate (fail closed). Refuse construction unless the caller has
  // explicitly acknowledged the unsandboxed-execution risk in code. This
  // turns the previous documentation-only warning into a runtime barrier:
  // a forgotten import or a copy-paste from an example will not silently
  // grant a model-generated script ambient host privileges.
  if (config.acknowledgeUnsandboxedExecution !== ACKNOWLEDGE_UNSANDBOXED_EXECUTION) {
    const error: KoiError = {
      code: "PERMISSION",
      message:
        "createExecuteCodeTool: this tool runs unsandboxed scripts with ambient host capabilities (fetch, filesystem). Pass acknowledgeUnsandboxedExecution: ACKNOWLEDGE_UNSANDBOXED_EXECUTION to opt in.",
      retryable: RETRYABLE_DEFAULTS.PERMISSION,
      context: { resourceId: "execute_code" },
    };
    return { ok: false, error };
  }

  // Validate defaultTimeoutMs at construction time. Otherwise a misconfigured
  // 0/NaN/-1/Infinity falls through into setTimeout and produces either an
  // immediate timeout or silently widens to MAX_TIMEOUT_MS — both surprising.
  if (config.defaultTimeoutMs !== undefined) {
    const dt = config.defaultTimeoutMs;
    if (typeof dt !== "number" || !Number.isFinite(dt) || dt <= 0 || dt > MAX_TIMEOUT_MS) {
      const error: KoiError = {
        code: "VALIDATION",
        message: `createExecuteCodeTool: defaultTimeoutMs must be a positive finite number ≤ ${MAX_TIMEOUT_MS}; got ${JSON.stringify(dt)}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
        context: { resourceId: "execute_code" },
      };
      return { ok: false, error };
    }
  }

  return buildTool({
    name: "execute_code",
    description: EXECUTE_CODE_DESCRIPTION,
    origin: "operator",
    // sandbox: false — this tool is NOT OS-sandboxed. Scripts run in a Bun
    // Worker thread that shares the host process's network/filesystem access.
    // Permission enforcement relies entirely on the callTool middleware chain
    // for tool calls made via tools.*; ambient Bun globals are unrestricted.
    // A true OS-sandbox adapter is deferred to a future package.
    sandbox: false,
    inputSchema: EXECUTE_CODE_SCHEMA,
    execute: async (args: JsonObject, options?: ToolExecuteOptions): Promise<unknown> => {
      const script = args.script;
      if (typeof script !== "string" || script.length === 0) {
        throw new Error("execute_code: script must be a non-empty string");
      }

      // Fail closed on bad timeout_ms: previously, 0/NaN/-1 silently widened
      // to the default timeout, granting hostile or buggy callers a longer
      // execution window than they asked for. Only undefined falls back.
      const rawTimeout = args.timeout_ms;
      let timeoutMs: number;
      if (rawTimeout === undefined) {
        // Clamp to MAX_TIMEOUT_MS as a defense-in-depth measure: construction
        // already rejects oversized values, but this keeps the fallback path
        // honest if validation ever drifts.
        timeoutMs = Math.min(config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      } else if (typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0) {
        timeoutMs = Math.min(rawTimeout, MAX_TIMEOUT_MS);
      } else {
        throw new Error(
          `execute_code: timeout_ms must be a positive finite number; got ${JSON.stringify(rawTimeout)}`,
        );
      }

      return executeScript({
        acknowledgeUnsandboxedExecution: ACKNOWLEDGE_UNSANDBOXED_EXECUTION,
        code: script,
        language: "typescript",
        timeoutMs,
        tools: config.tools,
        // Forward outer cancellation so aborting execute_code cancels the
        // worker and any in-flight nested tool call (with the caller's
        // original AbortSignal.reason preserved end-to-end).
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        ...(config.callTool !== undefined ? { callTool: config.callTool } : {}),
      });
    },
  });
}
