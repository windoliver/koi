import {
  type CancellationStatus,
  EVAL_DEFAULTS,
  type SelfTestCheck,
  type SelfTestCheckResult,
  type SelfTestOptions,
  type SelfTestResult,
} from "./types.js";

const RETURN_ACK_TIMEOUT_MS = 250;

interface OneResult {
  readonly pass: boolean;
  readonly message?: string | undefined;
  readonly cancellation: CancellationStatus;
}

export async function runSelfTest(
  checks: readonly SelfTestCheck[],
  options: SelfTestOptions = {},
): Promise<SelfTestResult> {
  const defaultTimeout = options.timeoutMs ?? EVAL_DEFAULTS.SELF_TEST_TIMEOUT_MS;
  const bail = options.bail ?? false;
  const results: SelfTestCheckResult[] = [];
  for (const check of checks) {
    const start = performance.now();
    const result = await runOne(check, check.timeoutMs ?? defaultTimeout);
    const durationMs = performance.now() - start;
    const cr: SelfTestCheckResult = {
      name: check.name,
      pass: result.pass,
      ...(result.message !== undefined ? { message: result.message } : {}),
      durationMs,
      cancellation: result.cancellation,
    };
    results.push(cr);
    // Always stop on `unconfirmed` cancellation: the underlying check may
    // still be running, so subsequent checks could overlap with it and
    // produce side-effects against shared state. This is the safe
    // default; callers cannot opt out (the leaked work is the bug, not
    // the stop).
    if (cr.cancellation === "unconfirmed") break;
    if (bail && !result.pass) break;
  }
  return { pass: results.every((r) => r.pass), checks: results };
}

/**
 * Sentinel string callers MUST include in their CheckResult message, or in
 * a thrown Error message, to acknowledge that they observed the abort
 * signal and stopped work. Any other result — including pass/fail with no
 * marker, or simple late settlement — is treated as `unconfirmed` so
 * callers cannot silently retry side-effects after a timeout.
 */
export const SELF_TEST_ABORT_REASON = "self-test:aborted";

const ABORT_ACK_REASON = SELF_TEST_ABORT_REASON;

async function runOne(check: SelfTestCheck, timeoutMs: number): Promise<OneResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const checkPromise = Promise.resolve()
    .then(() => check.run(controller.signal))
    .then((r) => ({ kind: "ok" as const, value: r }))
    .catch((e: unknown) => ({ kind: "err" as const, error: e }));
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(ABORT_ACK_REASON));
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const winner = await Promise.race([checkPromise, timeoutPromise]);
  if (timer !== undefined) clearTimeout(timer);

  if (winner.kind === "timeout") {
    // Wait briefly for the check to settle. To report `confirmed`, the
    // settlement MUST be a positive abort acknowledgement: either a
    // rejection whose reason matches our abort, or a CheckResult whose
    // message references our abort sentinel. Plain late-settled results
    // (e.g. ignoring the signal but finishing under the ack window) are
    // reported as `unconfirmed` — caller cannot assume work has stopped.
    const ack = await waitForAbortAck(checkPromise);
    return {
      pass: false,
      message: `timeout after ${timeoutMs}ms${ack ? "" : " (cancellation unconfirmed — work may still be running)"}`,
      cancellation: ack ? "confirmed" : "unconfirmed",
    };
  }
  if (winner.kind === "err") {
    return {
      pass: false,
      message: winner.error instanceof Error ? winner.error.message : String(winner.error),
      cancellation: "n/a",
    };
  }
  return {
    pass: winner.value.pass,
    ...(winner.value.message !== undefined ? { message: winner.value.message } : {}),
    cancellation: "n/a",
  };
}

async function waitForAbortAck(
  checkPromise: Promise<
    | { kind: "ok"; value: { readonly message?: string | undefined } }
    | { kind: "err"; error: unknown }
  >,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ackTimeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), RETURN_ACK_TIMEOUT_MS);
  });
  try {
    const settled = await Promise.race([checkPromise, ackTimeout]);
    if (settled === "timeout") return false;
    if (settled.kind === "err") {
      const e = settled.error;
      if (e instanceof Error && e.message.includes(ABORT_ACK_REASON)) return true;
      const cause = e instanceof Error ? (e.cause as unknown) : undefined;
      if (cause instanceof Error && cause.message.includes(ABORT_ACK_REASON)) return true;
      return false;
    }
    // Late-settled CheckResult: only count as ack when the implementation
    // explicitly references our abort sentinel in its message.
    return settled.value.message?.includes(ABORT_ACK_REASON) === true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
