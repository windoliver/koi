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
    if (bail && !result.pass) break;
  }
  return { pass: results.every((r) => r.pass), checks: results };
}

async function runOne(check: SelfTestCheck, timeoutMs: number): Promise<OneResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const checkPromise = Promise.resolve()
    .then(() => check.run(controller.signal))
    .then((r) => ({ kind: "ok" as const, value: r }))
    .catch((e: unknown) => ({ kind: "err" as const, error: e }));
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("timeout"));
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const winner = await Promise.race([checkPromise, timeoutPromise]);
  if (timer !== undefined) clearTimeout(timer);

  if (winner.kind === "timeout") {
    // Briefly wait for the check to acknowledge the abort. If it does, we
    // can confidently report cancellation as confirmed; otherwise the
    // underlying work may still be running.
    const ack = await raceCheckAck(checkPromise);
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

async function raceCheckAck(
  checkPromise: Promise<{ kind: "ok" | "err" } | unknown>,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ackTimeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), RETURN_ACK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([checkPromise.then(() => true).catch(() => true), ackTimeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
