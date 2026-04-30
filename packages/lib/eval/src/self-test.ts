import {
  type CheckResult,
  EVAL_DEFAULTS,
  type SelfTestCheck,
  type SelfTestCheckResult,
  type SelfTestOptions,
  type SelfTestResult,
} from "./types.js";

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
    };
    results.push(cr);
    if (bail && !result.pass) break;
  }
  return { pass: results.every((r) => r.pass), checks: results };
}

async function runOne(check: SelfTestCheck, timeoutMs: number): Promise<CheckResult> {
  try {
    return await withTimeout(Promise.resolve(check.run()), timeoutMs);
  } catch (e: unknown) {
    return { pass: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
