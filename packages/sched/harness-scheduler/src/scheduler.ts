import type { KoiError } from "@koi/core";
import type { HarnessScheduler, HarnessSchedulerConfig, SchedulerPhase } from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_CAP_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const TERMINAL_PHASES = new Set(["completed", "failed"]);

function computeBackoff(previousUpperMs: number, baseMs: number, capMs: number): number {
  const nextUpperMs = Math.min(capMs, previousUpperMs * 2);
  return Math.floor(baseMs + Math.random() * (nextUpperMs - baseMs));
}

function toInternalError(error: unknown): KoiError {
  return {
    code: "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    cause: error instanceof Error ? error : undefined,
  };
}

interface SchedulerState {
  phase: SchedulerPhase;
  retriesRemaining: number;
  totalResumes: number;
  lastError: KoiError | undefined;
  previousBackoffMs: number;
  stopRequested: boolean;
}

interface ResolvedConfig {
  readonly pollIntervalMs: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  readonly maxRetries: number;
  readonly delay: (ms: number) => Promise<void>;
}

function resolveConfig(config: HarnessSchedulerConfig): ResolvedConfig {
  return {
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
    backoffCapMs: config.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    delay:
      config.delay ??
      (async (ms: number): Promise<void> => {
        await Bun.sleep(ms);
      }),
  };
}

async function recordFailure(
  state: SchedulerState,
  error: KoiError,
  cfg: ResolvedConfig,
): Promise<boolean> {
  state.retriesRemaining -= 1;
  state.lastError = error;
  if (state.retriesRemaining <= 0) {
    state.phase = "failed";
    return true;
  }
  state.previousBackoffMs = computeBackoff(
    state.previousBackoffMs,
    cfg.backoffBaseMs,
    cfg.backoffCapMs,
  );
  await cfg.delay(state.previousBackoffMs);
  return false;
}

async function tryResumeOnce(
  state: SchedulerState,
  cfg: ResolvedConfig,
  config: HarnessSchedulerConfig,
): Promise<"terminate" | "continue"> {
  try {
    const result = await config.harness.resume();
    if (!result.ok) {
      return (await recordFailure(state, result.error, cfg)) ? "terminate" : "continue";
    }
    state.totalResumes += 1;
    state.retriesRemaining = cfg.maxRetries;
    state.lastError = undefined;
    state.previousBackoffMs = cfg.backoffBaseMs;
    if (config.onResumed !== undefined) {
      try {
        await config.onResumed(result.value);
      } catch (error: unknown) {
        const wrapped: KoiError = {
          code: "INTERNAL",
          message: `onResumed failed: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
          cause: error instanceof Error ? error : undefined,
        };
        if (await recordFailure(state, wrapped, cfg)) return "terminate";
      }
    }
    return "continue";
  } catch (error: unknown) {
    return (await recordFailure(state, toInternalError(error), cfg)) ? "terminate" : "continue";
  }
}

function initialState(cfg: ResolvedConfig): SchedulerState {
  return {
    phase: "idle",
    retriesRemaining: cfg.maxRetries,
    totalResumes: 0,
    lastError: undefined,
    previousBackoffMs: cfg.backoffBaseMs,
    stopRequested: false,
  };
}

async function runPollLoop(
  state: SchedulerState,
  cfg: ResolvedConfig,
  config: HarnessSchedulerConfig,
): Promise<void> {
  while (!state.stopRequested && state.phase === "running") {
    await cfg.delay(cfg.pollIntervalMs);
    if (config.signal?.aborted === true || state.stopRequested) {
      state.phase = "stopped";
      return;
    }
    const harnessPhase = config.harness.status().phase;
    if (TERMINAL_PHASES.has(harnessPhase)) {
      state.phase = "stopped";
      return;
    }
    if (harnessPhase !== "suspended") continue;
    if ((await tryResumeOnce(state, cfg, config)) === "terminate") return;
  }
  if (state.phase === "running") state.phase = "stopped";
}

export function createHarnessScheduler(config: HarnessSchedulerConfig): HarnessScheduler {
  const cfg = resolveConfig(config);
  const state = initialState(cfg);
  let pollPromise: Promise<void> | undefined;

  return {
    start: (): void => {
      if (state.phase !== "idle") return;
      state.phase = "running";
      pollPromise = runPollLoop(state, cfg, config);
    },
    stop: (): void => {
      state.stopRequested = true;
    },
    status: () => ({
      phase: state.phase,
      retriesRemaining: state.retriesRemaining,
      lastError: state.lastError,
      totalResumes: state.totalResumes,
    }),
    dispose: async (): Promise<void> => {
      state.stopRequested = true;
      await pollPromise;
    },
  };
}
