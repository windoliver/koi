import type { JsonObject, Tool } from "@koi/core";

// ---------------------------------------------------------------------------
// Script execution config
// ---------------------------------------------------------------------------

export interface ScriptConfig {
  /**
   * REQUIRED trust gate. The same acknowledgement enforced by
   * createExecuteCodeTool is enforced here so the lower-level executeScript
   * export cannot be used to bypass the package-level safety story.
   * Pass ACKNOWLEDGE_UNSANDBOXED_EXECUTION to opt in.
   */
  readonly acknowledgeUnsandboxedExecution: "I-understand-this-tool-bypasses-the-permission-middleware";
  readonly code: string;
  readonly language?: "javascript" | "typescript";
  /** Max execution time. Default: 30 000 ms. Hard cap: 300 000 ms. */
  readonly timeoutMs?: number;
  /** Max total tool calls the script may issue. Default: 50. */
  readonly maxToolCalls?: number;
  /** Tools exposed to the script via the `tools.*` object. */
  readonly tools: ReadonlyMap<string, Tool>;
  /**
   * Optional middleware-aware call function injected by L3.
   * When provided, inner tool calls go through the full permission/middleware chain.
   * Falls back to direct tool.execute() when absent (useful in tests).
   */
  readonly callTool?: (name: string, args: JsonObject, signal?: AbortSignal) => Promise<unknown>;
  readonly signal?: AbortSignal;
}

export interface ScriptResult {
  readonly ok: boolean;
  readonly result: unknown;
  readonly toolCallCount: number;
  readonly durationMs: number;
  readonly error?: string;
  /**
   * True when the script was terminated (timeout / external abort / concurrency
   * violation) while a tool call was still in flight. The local AbortSignal is
   * fired, but cooperative cancellation is best-effort: backends like MCP
   * cannot guarantee the remote operation did not commit. Callers MUST treat
   * `ok: false && inFlightAtSettlement: true` as indeterminate and NOT
   * blindly retry side-effecting operations.
   */
  readonly inFlightAtSettlement?: boolean;
}

// ---------------------------------------------------------------------------
// Worker protocol
// ---------------------------------------------------------------------------

/** Messages from the host to the worker. */
export type HostMessage =
  | {
      readonly kind: "run";
      readonly code: string;
    }
  | {
      readonly kind: "result";
      readonly id: string;
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly kind: "result";
      readonly id: string;
      readonly ok: false;
      readonly error: string;
    };

/** Messages from the worker to the host. */
export type WorkerMessage =
  | { readonly kind: "call"; readonly id: string; readonly name: string; readonly args: unknown }
  | { readonly kind: "done"; readonly result: unknown }
  | { readonly kind: "error"; readonly message: string };
