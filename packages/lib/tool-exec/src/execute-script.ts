import type { JsonObject } from "@koi/core";
import { transpileTs } from "./transpile.js";
import type { ScriptConfig, ScriptResult, WorkerMessage } from "./types.js";

function parseWorkerMessage(data: unknown): WorkerMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  const kind = msg.kind;
  if (kind === "done") return { kind: "done", result: msg.result ?? null };
  if (kind === "error" && typeof msg.message === "string")
    return { kind: "error", message: msg.message };
  if (kind === "call" && typeof msg.id === "string" && typeof msg.name === "string")
    return { kind: "call", id: msg.id, name: msg.name, args: msg.args };
  return null;
}

export const MAX_TIMEOUT_MS = 300_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TOOL_CALLS = 50;

/**
 * Execute a user script in an isolated Bun Worker thread.
 *
 * The worker receives pre-transpiled JS and a list of tool names. Each
 * `tools.name(args)` call posts a message to the host, which executes the
 * real tool (optionally through the middleware chain via config.callTool)
 * and posts the result back.
 *
 * Only the final return value of the script is returned — intermediate tool
 * results stay internal and never touch the model's context window.
 */
export async function executeScript(config: ScriptConfig): Promise<ScriptResult> {
  // Trust gate (fail closed). Same opt-in enforced by createExecuteCodeTool —
  // applied here so the lower-level export cannot be used to silently grant
  // ambient host capabilities (fetch, Bun.file) to model-generated code.
  if (
    config.acknowledgeUnsandboxedExecution !==
    "I-understand-this-tool-bypasses-the-permission-middleware"
  ) {
    return {
      ok: false,
      result: null,
      toolCallCount: 0,
      durationMs: 0,
      error:
        "executeScript: this API runs unsandboxed scripts with ambient host capabilities. Pass acknowledgeUnsandboxedExecution: ACKNOWLEDGE_UNSANDBOXED_EXECUTION to opt in.",
    };
  }

  // Fail immediately if cancellation was already requested before we start.
  if (config.signal?.aborted === true) {
    return { ok: false, result: null, toolCallCount: 0, durationMs: 0, error: "Script aborted" };
  }

  const start = Date.now();

  // Validate guardrails here — executeScript is a public export and callers
  // could otherwise pass NaN/Infinity/negative values that silently disable
  // the timeout (setTimeout(NaN) → immediate) or the tool-call budget
  // (toolCallCount > NaN is always false). That would neutralize the main
  // safety controls on model-generated code execution.
  const rawTimeout = config.timeoutMs;
  if (
    rawTimeout !== undefined &&
    (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0)
  ) {
    return {
      ok: false,
      result: null,
      toolCallCount: 0,
      durationMs: 0,
      error: `executeScript: timeoutMs must be a positive finite number; got ${JSON.stringify(rawTimeout)}`,
    };
  }
  const rawBudget = config.maxToolCalls;
  if (
    rawBudget !== undefined &&
    (typeof rawBudget !== "number" || !Number.isInteger(rawBudget) || rawBudget < 0)
  ) {
    return {
      ok: false,
      result: null,
      toolCallCount: 0,
      durationMs: 0,
      error: `executeScript: maxToolCalls must be a non-negative integer; got ${JSON.stringify(rawBudget)}`,
    };
  }
  const timeoutMs = Math.min(rawTimeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxToolCalls = rawBudget ?? DEFAULT_MAX_TOOL_CALLS;

  // Both TS and plain JS go through transpileTs: it wraps the body in an
  // async function expression and (for TS) strips type annotations.
  const code = transpileTs(config.code);

  // .js extension resolves to worker-entry.ts in source (Bun NodeNext) and
  // worker-entry.js in the built dist — correct in both modes.
  const workerUrl = new URL("./worker-entry.js", import.meta.url);
  const worker = new Worker(workerUrl);

  let toolCallCount = 0;
  // Enforces the sequential-only contract: only one host-side tool call at a time.
  let toolCallPending = false;

  // Per-call AbortController. Created when a tool call begins, cleared when it
  // settles. Using a single shared controller would retroactively abort
  // already-completed calls (their `signal.aborted` would flip to true after
  // success), causing tools that keep abort listeners alive (rollback, telemetry,
  // child-process kill) to fire on the success path.
  let activeController: AbortController | null = null;

  const cleanup = (): void => {
    worker.terminate();
  };

  const result = await new Promise<ScriptResult>((resolve) => {
    let settled = false;

    // Single shared finalizer: clear timer, drop abort listener, cancel any
    // in-flight tool call, and terminate the worker. Every exit path goes
    // through here so we never leak timers or listeners on long-lived signals.
    // Stamps `inFlightAtSettlement` on failure when a tool call is still
    // running so callers know the result is indeterminate (cooperative abort
    // does not guarantee remote backends like MCP have not committed).
    // Forwards the parent signal's abort reason so downstream tools and
    // middleware can distinguish timeout vs user-cancel vs upstream shutdown.
    const settle = (r: ScriptResult, abortReason?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      config.signal?.removeEventListener("abort", onAbort);
      const inFlight = activeController !== null;
      // Path-specific abort reason so nested tools can distinguish timeout
      // vs external abort vs concurrency violation. Falls back to the
      // caller's signal.reason when none is provided so user-cancel is
      // preserved end-to-end.
      activeController?.abort(abortReason ?? config.signal?.reason);
      cleanup();
      resolve(!r.ok && inFlight ? { ...r, inFlightAtSettlement: true } : r);
    };

    // Safe wrapper: drop any worker message that races settlement so we never
    // call postMessage on a terminated worker (would throw InvalidStateError).
    const postToWorker = (message: unknown): void => {
      if (settled) return;
      worker.postMessage(message);
    };

    const timeoutHandle = setTimeout(() => {
      // DOMException with name "TimeoutError" matches `AbortSignal.timeout()`
      // convention; downstream code (e.g. tool-execution-guard) can check
      // `name === "TimeoutError"` to classify this as a timeout rather than
      // a generic abort.
      const timeoutReason = new DOMException(
        `Script timed out after ${timeoutMs}ms`,
        "TimeoutError",
      );
      settle(
        {
          ok: false,
          result: null,
          toolCallCount,
          durationMs: Date.now() - start,
          error: `Script timed out after ${timeoutMs}ms`,
        },
        timeoutReason,
      );
    }, timeoutMs);

    // Abort signal interop: cancel if caller aborts
    const onAbort = (): void => {
      settle({
        ok: false,
        result: null,
        toolCallCount,
        durationMs: Date.now() - start,
        error: "Script aborted",
      });
    };
    config.signal?.addEventListener("abort", onAbort, { once: true });

    // Close the startup race: if the caller aborted between executeScript()
    // entry and listener registration, AbortSignal does not replay the event,
    // so re-check aborted here and settle before we post `run` to the worker.
    if (config.signal?.aborted === true) {
      onAbort();
      return;
    }

    worker.onmessage = async (event: MessageEvent<unknown>): Promise<void> => {
      // Fail closed if a worker message races settlement. Without this guard
      // a `call` posted just before a timeout/abort would still be processed,
      // launching a fresh tool execution AFTER the run has already failed —
      // a perfect setup for late or duplicate side effects.
      if (settled) return;
      const msg = parseWorkerMessage(event.data);
      if (msg === null) return;

      if (msg.kind === "done") {
        // Fail closed if the script returned while a tool call is still in
        // flight (e.g. `tools.write({...}); return "ok";` — missing await).
        // Settling success here would silently abort the side-effecting tool
        // and report `ok: true` for an indeterminate run.
        if (toolCallPending) {
          settle({
            ok: false,
            result: null,
            toolCallCount,
            durationMs: Date.now() - start,
            error:
              "Script returned while a tool call was still in flight — every tools.* call must be awaited",
          });
          return;
        }
        settle({ ok: true, result: msg.result, toolCallCount, durationMs: Date.now() - start });
        return;
      }

      if (msg.kind === "error") {
        settle({
          ok: false,
          result: null,
          toolCallCount,
          durationMs: Date.now() - start,
          error: msg.message,
        });
        return;
      }

      if (msg.kind === "call") {
        if (toolCallPending) {
          // Fail closed: a concurrency violation is a script bug, not a
          // recoverable per-call error. Returning an error to the rogue call
          // would let a `Promise.allSettled`-style script ignore it and still
          // claim success after partial side effects; it also lets an
          // unbounded spam of concurrent calls bypass `maxToolCalls`. Abort
          // the whole script instead.
          settle({
            ok: false,
            result: null,
            toolCallCount,
            durationMs: Date.now() - start,
            error: "Concurrent tool calls are not supported; await each call sequentially",
          });
          return;
        }

        toolCallCount++;

        if (toolCallCount > maxToolCalls) {
          postToWorker({
            kind: "result",
            id: msg.id,
            ok: false,
            error: "Tool call budget exceeded",
          });
          return;
        }

        // Fail closed on malformed arguments. Primitives, null, and arrays are
        // explicit invocation bugs and would otherwise be coerced to `{}`,
        // hiding the bug and calling tools with empty defaults. `undefined`
        // (no args at all, e.g. `tools.noop()`) is treated as `{}` for tools
        // with empty/optional schemas — that's the documented zero-arg case.
        if (msg.args === undefined) {
          // proceed with empty object below
        } else if (typeof msg.args !== "object" || msg.args === null || Array.isArray(msg.args)) {
          postToWorker({
            kind: "result",
            id: msg.id,
            ok: false,
            error: `Tool arguments must be a plain object; got ${msg.args === null ? "null" : Array.isArray(msg.args) ? "array" : typeof msg.args}`,
          });
          return;
        }
        const args = (msg.args ?? {}) as JsonObject;
        toolCallPending = true;
        const callController = new AbortController();
        // Inherit outer cancellation state. If config.signal already fired
        // between the worker posting `call` and host handling it, the
        // per-call signal must start aborted so cooperative tools refuse to
        // start work rather than discovering cancellation mid-execution.
        if (config.signal?.aborted === true) {
          callController.abort(config.signal.reason);
        }
        activeController = callController;

        try {
          let value: unknown;

          if (config.callTool !== undefined) {
            value = await config.callTool(msg.name, args, callController.signal);
          } else {
            const tool = config.tools.get(msg.name);
            if (tool === undefined) {
              postToWorker({
                kind: "result",
                id: msg.id,
                ok: false,
                error: `Unknown tool: ${msg.name}`,
              });
              return;
            }
            value = await tool.execute(args, { signal: callController.signal });
          }

          postToWorker({ kind: "result", id: msg.id, ok: true, value: value ?? null });
        } catch (e: unknown) {
          // Suppress errors from tools that were aborted as part of settlement —
          // they would otherwise become a misleading "error" message after the
          // script has already failed for an unrelated reason.
          if (settled) return;
          postToWorker({
            kind: "result",
            id: msg.id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        } finally {
          toolCallPending = false;
          // Clear only if this call is still the active one — settle() may
          // have replaced it (no-op in current design, but keep defensive).
          if (activeController === callController) activeController = null;
        }
      }
    };

    worker.onerror = (error: ErrorEvent): void => {
      clearTimeout(timeoutHandle);
      config.signal?.removeEventListener("abort", onAbort);
      settle({
        ok: false,
        result: null,
        toolCallCount,
        durationMs: Date.now() - start,
        error: error.message,
      });
    };

    worker.postMessage({ kind: "run", code });
  });

  return result;
}
