import type { ContentBlock, EngineEvent, EngineInput } from "@koi/core";
import { createEmitter } from "./emit.js";
import { HEADLESS_EXIT, type HeadlessExitCode, mapErrorToExitCode } from "./exit-codes.js";
import { ndjsonSafeStringify } from "./ndjson-safe-stringify.js";

export { HEADLESS_EXIT };

/**
 * Emit a standalone terminal `result` event for the deadline-backstop path.
 * Used when the backstop fires before runHeadless() has returned an
 * emitResult callback. Does NOT emit `session_start` — the caller owns that
 * emission at the start of the headless branch (see commands/start.ts) so
 * the stream never carries two session headers.
 */
export function emitPreRunTimeoutResult(
  sessionId: string,
  writeStdout: (chunk: string) => void,
  error: string,
): void {
  writeStdout(
    `${ndjsonSafeStringify({
      kind: "result",
      sessionId,
      ok: false,
      exitCode: HEADLESS_EXIT.TIMEOUT,
      error,
    })}\n`,
  );
}

/** Emit the single `session_start` line. Caller-owned so the backstop path
 *  does not double-emit. Used by commands/start.ts before runHeadless. */
export function emitHeadlessSessionStart(
  sessionId: string,
  writeStdout: (chunk: string) => void,
): void {
  writeStdout(
    `${ndjsonSafeStringify({
      kind: "session_start",
      sessionId,
      startedAt: new Date().toISOString(),
    })}\n`,
  );
}

interface HeadlessRuntime {
  readonly run: (input: EngineInput) => AsyncIterable<EngineEvent>;
}

interface RunHeadlessOptions {
  readonly sessionId: string;
  readonly prompt: string;
  readonly maxDurationMs: number | undefined;
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly runtime: HeadlessRuntime;
  readonly externalSignal?: AbortSignal | undefined;
}

export interface HeadlessOutcome {
  readonly exitCode: HeadlessExitCode;
  /**
   * Emit the terminal `result` NDJSON line. Call after caller-side teardown
   * (e.g. shutdownRuntime()) so the stream's final ok/exitCode match the
   * process exit code. Pass `override` to surface a shutdown failure or
   * similar post-run reclassification (e.g. teardown bumped 0 → 5).
   */
  readonly emitResult: (override?: {
    readonly exitCode: HeadlessExitCode;
    readonly error?: string;
  }) => void;
}

export async function runHeadless(opts: RunHeadlessOptions): Promise<HeadlessOutcome> {
  // session_start is emitted by the caller (see commands/start.ts) so the
  // deadline backstop can fall back to `emitPreRunTimeoutResult` without
  // duplicating the session header if it fires mid-run.
  const emit = createEmitter({ sessionId: opts.sessionId, write: opts.writeStdout });

  const controller = new AbortController();
  // Honor an already-aborted externalSignal on entry. addEventListener does
  // NOT fire for already-aborted signals, so without this check a SIGINT
  // that arrived during bootstrap would be lost and the run would still
  // execute. Also short-circuit BEFORE calling runtime.run() — aborting
  // the controller alone doesn't prevent the engine from starting
  // side-effecting work; the runtime has to observe the signal on its
  // next tick. Fail closed on an already-cancelled invocation.
  if (opts.externalSignal?.aborted === true) {
    controller.abort();
    const cancelledEmitResult = (override?: {
      readonly exitCode: HeadlessExitCode;
      readonly error?: string;
    }): void => {
      emit({
        kind: "result",
        ok: false,
        exitCode: override?.exitCode ?? HEADLESS_EXIT.AGENT_FAILURE,
        error: override?.error ?? "cancelled before run started",
      });
    };
    return { exitCode: HEADLESS_EXIT.AGENT_FAILURE, emitResult: cancelledEmitResult };
  }
  // Track whether the timer fired so we can distinguish a max-duration abort
  // from an externalSignal abort (SIGINT). Both feed into the same controller
  // but the exit-code mapping differs: timeout → 4, external → 1.
  let timedOut = false;
  const timer =
    opts.maxDurationMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, opts.maxDurationMs)
      : undefined;
  const externalAbortHandler = (): void => controller.abort();
  opts.externalSignal?.addEventListener("abort", externalAbortHandler, { once: true });

  const toolNamesByCallId = new Map<string, string>();
  // let: mutable across event loop iterations.
  let exitCode: HeadlessExitCode = HEADLESS_EXIT.SUCCESS;
  let errMessage: string | undefined;
  let sawDone = false;
  let emittedAssistantText = false;

  try {
    for await (const event of opts.runtime.run({
      kind: "text",
      text: opts.prompt,
      signal: controller.signal,
    })) {
      if (translateEvent(event, emit, toolNamesByCallId)) {
        emittedAssistantText = true;
      }
      if (event.kind === "done") {
        sawDone = true;
        if (!emittedAssistantText) {
          const fallback = extractTextFromContent(event.output.content);
          if (fallback.length > 0) {
            // Redact engine error banners here too — done.output.content
            // is populated from the same reason string at engine-catch
            // time, so it can carry the same secret-bearing interpolated
            // error.message text as text_delta does.
            emit({ kind: "assistant_text", text: redactEngineBanners(fallback) });
            emittedAssistantText = true;
          }
        }
        // If our deadline timer fired before the engine emitted done, the
        // engine's catch path remaps that abort to stopReason "interrupted"
        // (kernel/engine/src/koi.ts:1458). Promote that specific case to
        // TIMEOUT so --max-duration-ms is reported as exit 4, not exit 1.
        if (timedOut) {
          exitCode = HEADLESS_EXIT.TIMEOUT;
          errMessage = "max-duration-ms exceeded";
        } else {
          const embeddedMessage = extractEngineErrorMessage(event.output.metadata);
          const mapped = mapStopReasonToExitCode(event.output.stopReason, embeddedMessage);
          if (mapped.exitCode !== HEADLESS_EXIT.SUCCESS) {
            exitCode = mapped.exitCode;
            errMessage = mapped.message;
          }
        }
      }
    }
    if (!sawDone && timedOut) {
      exitCode = HEADLESS_EXIT.TIMEOUT;
      errMessage = "max-duration-ms exceeded";
    } else if (!sawDone && controller.signal.aborted) {
      exitCode = HEADLESS_EXIT.AGENT_FAILURE;
      errMessage = "run cancelled";
    } else if (!sawDone) {
      exitCode = HEADLESS_EXIT.AGENT_FAILURE;
      errMessage = "engine stream ended without a 'done' event";
    }
  } catch (e: unknown) {
    // Redaction: the thrown error's `.message` can carry Bash stderr,
    // HTTP errors, MCP transport failures, or other sensitive text. The
    // stopReason "error" path already sanitizes this; apply the same
    // policy here so the catch-side leak isn't a bypass. The raw text
    // still goes to stderr (unredacted) for human debugging.
    const rawErr = extractErrorMessage(e);
    if (timedOut) {
      exitCode = HEADLESS_EXIT.TIMEOUT;
      errMessage = "max-duration-ms exceeded";
    } else if (controller.signal.aborted) {
      exitCode = HEADLESS_EXIT.AGENT_FAILURE;
      errMessage = "run cancelled";
    } else {
      exitCode = mapErrorToExitCode(e);
      // CI stderr is captured alongside stdout, so raw exception text
      // there is the same exfiltration vector as on NDJSON. Emit only a
      // classification on both streams in headless mode, but keep it
      // informative: include the error constructor name (KoiRuntimeError,
      // AbortError, TypeError) or KoiError code so operators can tell
      // retry-safe categories from retry-unsafe ones without seeing the
      // raw message.
      const rawText = rawErr ?? String(e);
      const errClass = classifyErrorShape(e);
      if (exitCode === HEADLESS_EXIT.INTERNAL) {
        opts.writeStderr(
          `koi headless: internal error [${errClass}] (${rawText.length} chars redacted)\n`,
        );
        errMessage = `internal error [${errClass}] (${rawText.length} chars redacted)`;
      } else {
        errMessage =
          rawErr !== undefined
            ? `engine error [${errClass}] (${rawErr.length} chars redacted)`
            : `engine error [${errClass}]`;
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts.externalSignal?.removeEventListener("abort", externalAbortHandler);
  }

  // let: true once emitResult has been invoked. Guards against double-emit
  // and ensures a fallback emit if the caller never calls it (defensive).
  let resultEmitted = false;
  const emitResult = (override?: {
    readonly exitCode: HeadlessExitCode;
    readonly error?: string;
  }): void => {
    if (resultEmitted) return;
    resultEmitted = true;
    const finalCode = override?.exitCode ?? exitCode;
    const finalError = override?.error ?? errMessage;
    emit({
      kind: "result",
      ok: finalCode === HEADLESS_EXIT.SUCCESS,
      exitCode: finalCode,
      ...(finalError !== undefined ? { error: finalError } : {}),
    });
    // Observability: CI operators need at least one actionable line on
    // stderr for every non-success run. The message is already
    // redacted (the catch/error paths replaced raw text with length-
    // classifier strings before this point), so it's safe to mirror.
    // Success runs stay silent on stderr to match the historical
    // contract.
    if (finalCode !== HEADLESS_EXIT.SUCCESS) {
      opts.writeStderr(
        `koi headless: exit ${finalCode}${finalError !== undefined ? ` — ${finalError}` : ""}\n`,
      );
    }
  };
  return { exitCode, emitResult };
}

/**
 * Permission-denial patterns emitted by the pattern backend
 * (see packages/security/middleware-permissions/src/classifier.ts).
 * When a run terminates with stopReason "error" and the engine's embedded
 * errorMessage contains one of these markers, we surface exit 2 instead of
 * the generic exit 1 so CI automation can distinguish policy denials.
 */
const PERMISSION_DENIAL_MARKERS: readonly string[] = [
  "denied by policy",
  "not in allow list",
  // headlessDenyHandler's fail-closed reason; matches the approval-handler
  // path (Bash uncertain-AST elicit, MCP tools requesting approval).
  "headless mode: interactive approval",
];

/**
 * Lowercase substrings that indicate the engine remapped a real timeout to
 * stopReason "max_turns". When any of these appears in metadata.errorMessage
 * we surface exit 4 (TIMEOUT) rather than exit 3 (BUDGET_EXCEEDED).
 */
const TIMEOUT_MESSAGE_MARKERS: readonly string[] = [
  "timeout",
  "timed out",
  "deadline",
  // Engine's wall-clock guard message shape
  // (kernel/engine-compose/src/guards.ts).
  "duration limit",
];

function mapStopReasonToExitCode(
  reason: "completed" | "max_turns" | "interrupted" | "error",
  errorMessage: string | undefined,
): { readonly exitCode: HeadlessExitCode; readonly message: string | undefined } {
  switch (reason) {
    case "completed":
      return { exitCode: HEADLESS_EXIT.SUCCESS, message: undefined };
    case "max_turns": {
      // Ambiguous in the engine: turn-runner uses "max_turns" for genuine
      // turn-budget exhaustion (no metadata.errorMessage), while the engine
      // catch path (packages/kernel/engine/src/koi.ts:1460) also remaps
      // KoiRuntimeError(TIMEOUT) to stopReason "max_turns" and embeds the
      // timeout message in metadata. Peek at the message to reclassify.
      if (
        errorMessage !== undefined &&
        TIMEOUT_MESSAGE_MARKERS.some((m) => errorMessage.toLowerCase().includes(m))
      ) {
        // Timeout messages like "Duration limit exceeded: 5000ms" are
        // classifier-generated from engine guards — not arbitrary user/tool
        // output — so safe to include verbatim.
        return { exitCode: HEADLESS_EXIT.TIMEOUT, message: errorMessage };
      }
      return {
        exitCode: HEADLESS_EXIT.BUDGET_EXCEEDED,
        message: "engine hit max turns",
      };
    }
    case "interrupted":
      return { exitCode: HEADLESS_EXIT.AGENT_FAILURE, message: "engine run interrupted" };
    case "error": {
      if (
        errorMessage !== undefined &&
        PERMISSION_DENIAL_MARKERS.some((m) => errorMessage.includes(m))
      ) {
        // Denial messages from the pattern backend/approval handler carry
        // fixed phrasing plus a tool name — safe to surface to CI.
        return {
          exitCode: HEADLESS_EXIT.PERMISSION_DENIED,
          message: errorMessage,
        };
      }
      // Generic stopReason "error" — errorMessage here is derived from
      // the original KoiRuntimeError's `.message` field, which for
      // non-KoiError bubbles (Bash subprocess stderr, HTTP fetch errors,
      // MCP transport failures) can contain secrets, URLs, or tenant
      // data. Do NOT forward verbatim to CI logs; emit a classification
      // + length marker instead. Operators can still see the full text
      // on stderr via the normal engine rendering path.
      return {
        exitCode: HEADLESS_EXIT.AGENT_FAILURE,
        message:
          errorMessage !== undefined
            ? `engine error (${errorMessage.length} chars redacted; see stderr)`
            : "engine reported error",
      };
    }
  }
}

/**
 * The engine embeds `metadata: { errorMessage }` on the done event when it
 * converts a KoiRuntimeError into a terminal stopReason (see
 * packages/kernel/engine/src/koi.ts:1481-1495). Pull it out so headless can
 * distinguish permission denials from other engine-level failures.
 */
function extractEngineErrorMessage(
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (metadata === undefined) return undefined;
  const em = metadata.errorMessage;
  return typeof em === "string" ? em : undefined;
}

/**
 * Classify a thrown value for the headless NDJSON/stderr envelope without
 * leaking its raw message. Returns the constructor name for Error
 * instances (e.g. "KoiRuntimeError", "AbortError", "TypeError") or the
 * KoiError code for `{code, message}` shapes, or "unknown" otherwise.
 * This is the diagnostic channel CI operators use to decide retry
 * safety without seeing the full error text.
 */
function classifyErrorShape(e: unknown): string {
  if (e instanceof Error) {
    const name = e.constructor.name;
    return name.length > 0 ? name : "Error";
  }
  if (typeof e === "object" && e !== null && "code" in e) {
    const code = (e as { readonly code: unknown }).code;
    if (typeof code === "string") return `KoiError:${code}`;
  }
  return typeof e;
}

function extractErrorMessage(e: unknown): string | undefined {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) {
    const m = (e as { readonly message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return undefined;
}

function extractTextFromContent(content: readonly ContentBlock[]): string {
  return content
    .filter(
      (b): b is ContentBlock & { readonly kind: "text"; readonly text: string } =>
        b.kind === "text",
    )
    .map((b) => b.text)
    .join("");
}

/**
 * Tools that failed mid-run surface as synthetic tool_result outputs of shape
 * `{ error: string, code: "TOOL_EXECUTION_ERROR" }` (query-engine/turn-runner).
 * Detecting the shape lets headless NDJSON report `ok: false` instead of
 * silently masking the failure as a successful result.
 */
/**
 * Redacted form of a TOOL_EXECUTION_ERROR payload. Keeps the `code`
 * (fixed vocabulary, safe) plus an errorSize marker for debugging.
 * Does NOT include the raw error message — that comes from caught
 * exception text and can carry sensitive data on the failure path CI
 * operators inspect most.
 */
function summarizeToolExecutionError(output: unknown): {
  readonly code: string;
  readonly errorSize: number;
} {
  if (typeof output !== "object" || output === null) {
    return { code: "TOOL_EXECUTION_ERROR", errorSize: 0 };
  }
  const rec = output as { readonly error?: unknown; readonly code?: unknown };
  const code = typeof rec.code === "string" ? rec.code : "TOOL_EXECUTION_ERROR";
  const errorSize = typeof rec.error === "string" ? rec.error.length : 0;
  return { code, errorSize };
}

function isToolExecutionError(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  if (!("code" in output)) return false;
  const code = (output as { readonly code: unknown }).code;
  return code === "TOOL_EXECUTION_ERROR";
}

/**
 * Summarize a payload without leaking its content. CI log safety: tool args
 * and results can carry .env contents, bearer tokens, tenant data, etc. The
 * NDJSON stream is routinely persisted to build logs, so by default we emit
 * shape metadata only (type + size) — not values. Users who need full
 * payloads for debugging can add `--emit-tool-payloads` in a follow-up PR.
 */
function summarizePayload(value: unknown): { readonly type: string; readonly size?: number } {
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "string", size: value.length };
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return { type: typeof value };
  }
  if (Array.isArray(value)) return { type: "array", size: value.length };
  if (typeof value === "object") {
    const keys = Object.keys(value);
    return { type: "object", size: keys.length };
  }
  return { type: typeof value };
}

/**
 * Engine banner patterns (kernel/engine/src/koi.ts:1474-1493) that
 * interpolate the original `error.message` into assistant text:
 *   "[Turn stopped: <msg>. Raise the session budget or resubmit to continue.]"
 *   "[Turn failed: <msg>.]"
 *
 * These banners are normally valuable context, but in headless mode the
 * `<msg>` is raw error text (Bash stderr, HTTP URLs, tokens, tenant ids)
 * and stdout is captured by CI. Replace with a redacted summary so the
 * secret never reaches build logs.
 *
 * "[Turn interrupted before the model produced a reply.]" carries no
 * interpolation — leave it through.
 */
const ENGINE_ERROR_BANNER_RE = /\[Turn (stopped|failed):\s*([\s\S]+?)(\.\s*Raise[\s\S]*?)?\]/g;

function redactEngineBanners(text: string): string {
  return text.replace(ENGINE_ERROR_BANNER_RE, (_full, kind: string, msg: string) => {
    return `[Turn ${kind}: ${msg.length} chars redacted]`;
  });
}

/** Returns `true` if the event caused assistant text to be emitted. */
function translateEvent(
  event: EngineEvent,
  emit: ReturnType<typeof createEmitter>,
  toolNamesByCallId: Map<string, string>,
): boolean {
  switch (event.kind) {
    case "text_delta": {
      if (event.delta.length > 0) {
        emit({ kind: "assistant_text", text: redactEngineBanners(event.delta) });
        return true;
      }
      return false;
    }
    case "tool_call_start": {
      toolNamesByCallId.set(event.callId, event.toolName);
      // Default to redacted: emit only tool identity + args shape, never
      // the actual args. CI log exfiltration risk (see summarizePayload).
      emit({ kind: "tool_call", toolName: event.toolName, args: summarizePayload(event.args) });
      return false;
    }
    case "tool_result": {
      const toolName = toolNamesByCallId.get(event.callId) ?? "unknown";
      const ok = !isToolExecutionError(event.output);
      // TOOL_EXECUTION_ERROR payloads carry { error, code } where `error`
      // is the caught exception's .message — for Bash/HTTP tools that can
      // include stderr fragments, URLs, tokens, or tenant data. Passing it
      // through would defeat the CI-log redaction goal. Emit the code for
      // observability (it's a fixed vocabulary) and a length-only summary
      // of the error text; full text is available locally via the tool's
      // own logs or a future --emit-tool-payloads opt-in.
      const result = ok
        ? summarizePayload(event.output)
        : summarizeToolExecutionError(event.output);
      emit({ kind: "tool_result", toolName, ok, result });
      return false;
    }
    default:
      return false;
  }
}
