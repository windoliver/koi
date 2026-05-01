/**
 * One iteration of the verified loop: select item, run runner, run gate,
 * persist outcome, append learning, and emit the iteration record.
 *
 * Extracted so verified-loop.ts owns only the lifecycle shell (lock,
 * heartbeat, abort wiring, final-result aggregation).
 */

import { extractMessage } from "@koi/errors";
import { appendLearning, readLearnings } from "./learnings.js";
import { nextItem, type PRDLock, readPRD, refreshPRDLock } from "./prd-store.js";
import { drainWithAbort, RunnerStuckError } from "./runner-drain.js";
import type {
  EngineInput,
  IterationRecord,
  LearningsEntry,
  PRDItem,
  VerificationResult,
  VerifiedLoopConfig,
} from "./types.js";
import type { ResolvedConfig } from "./verified-loop-config.js";
import { runGate } from "./verified-loop-gate.js";
import { persistCompletion, persistFailureBump } from "./verified-loop-persist.js";

export interface RunIterationArgs {
  readonly iteration: number;
  readonly config: VerifiedLoopConfig;
  readonly resolved: ResolvedConfig;
  readonly abortController: AbortController;
  readonly lock: PRDLock;
  readonly iterationRecords: IterationRecord[];
}

export async function runIteration(args: RunIterationArgs): Promise<"continue" | "no-more-items"> {
  const { iteration, config, resolved, abortController, lock, iterationRecords } = args;
  const iterStart = performance.now();

  await refreshOrThrow(lock);
  const currentPrd = await readPRDOrThrow(resolved.prdPath);

  const current = nextItem(currentPrd.items);
  if (!current) return "no-more-items";

  const learnings = await readLearnings(resolved.learningsPath);
  const remainingItems = currentPrd.items.filter((x) => !x.done && !x.skipped);
  const completedItems = currentPrd.items.filter((x) => x.done);

  // Construct iterSignal in outer scope so we can check `.aborted`
  // after the drain to decide whether the iteration's work is trusted.
  const iterSignal = AbortSignal.any([
    abortController.signal,
    AbortSignal.timeout(resolved.iterationTimeoutMs),
  ]);
  const { gateResult, iterError } = await runRunnerAndGate({
    iteration,
    config,
    resolved,
    current,
    remainingItems,
    completedItems,
    learnings,
    iterationRecords,
    abortController,
    iterSignal,
  });

  await persistAndFinalize({
    config,
    resolved,
    abortController,
    lock,
    iteration,
    iterStart,
    current,
    gateResult,
    iterError,
    iterSignal,
    items: currentPrd.items,
    iterationRecords,
  });
  return "continue";
}

interface PersistAndFinalizeArgs {
  readonly config: VerifiedLoopConfig;
  readonly resolved: ResolvedConfig;
  readonly abortController: AbortController;
  readonly lock: PRDLock;
  readonly iteration: number;
  readonly iterStart: number;
  readonly current: PRDItem;
  readonly gateResult: VerificationResult;
  readonly iterError: string | undefined;
  readonly iterSignal: AbortSignal;
  readonly items: readonly PRDItem[];
  readonly iterationRecords: IterationRecord[];
}

async function persistAndFinalize(args: PersistAndFinalizeArgs): Promise<void> {
  await persistOutcome({
    resolved: args.resolved,
    lock: args.lock,
    abortController: args.abortController,
    current: args.current,
    gateResult: args.gateResult,
    iterError: args.iterError,
    iterSignal: args.iterSignal,
    items: args.items,
  });
  await finalizeIteration({
    config: args.config,
    resolved: args.resolved,
    iteration: args.iteration,
    iterStart: args.iterStart,
    current: args.current,
    gateResult: args.gateResult,
    iterError: args.iterError,
    iterationRecords: args.iterationRecords,
  });
}

interface FinalizeIterationArgs {
  readonly config: VerifiedLoopConfig;
  readonly resolved: ResolvedConfig;
  readonly iteration: number;
  readonly iterStart: number;
  readonly current: PRDItem;
  readonly gateResult: VerificationResult;
  readonly iterError: string | undefined;
  readonly iterationRecords: IterationRecord[];
}

async function finalizeIteration(args: FinalizeIterationArgs): Promise<void> {
  await recordIterationLearning({
    learningsPath: args.resolved.learningsPath,
    maxLearningEntries: args.resolved.maxLearningEntries,
    iteration: args.iteration,
    current: args.current,
    gateResult: args.gateResult,
    iterError: args.iterError,
  });

  const record: IterationRecord = {
    iteration: args.iteration,
    itemId: args.current.id,
    durationMs: performance.now() - args.iterStart,
    gateResult: args.gateResult,
    error: args.iterError,
  };
  args.iterationRecords.push(record);
  invokeOnIteration(args.config, record);
}

interface RunnerAndGateArgs {
  readonly iteration: number;
  readonly config: VerifiedLoopConfig;
  readonly resolved: ResolvedConfig;
  readonly current: PRDItem;
  readonly remainingItems: readonly PRDItem[];
  readonly completedItems: readonly PRDItem[];
  readonly learnings: readonly LearningsEntry[];
  readonly iterationRecords: readonly IterationRecord[];
  readonly abortController: AbortController;
  readonly iterSignal: AbortSignal;
}

interface RunnerAndGateOutcome {
  readonly gateResult: VerificationResult;
  readonly iterError: string | undefined;
}

async function runRunnerAndGate(args: RunnerAndGateArgs): Promise<RunnerAndGateOutcome> {
  const promptText = args.config.iterationPrompt({
    iteration: args.iteration,
    currentItem: args.current,
    remainingItems: args.remainingItems,
    completedItems: args.completedItems,
    learnings: args.learnings,
    totalIterations: args.resolved.maxIterations,
  });
  const runOutcome = await runRunner(args.config, promptText, args.iterSignal);

  // Use let — justified: mutable error tracking across try/catch
  let iterError = runOutcome.iterError;
  if (args.iterSignal.aborted || iterError !== undefined) {
    return { gateResult: makeAbortedGateResult(args.iterSignal, iterError), iterError };
  }
  const gateOutcome = await runGate({
    verify: args.config.verify,
    iteration: args.iteration,
    currentItem: args.current,
    workingDir: args.resolved.workingDir,
    iterationRecords: args.iterationRecords,
    learnings: args.learnings,
    remainingItems: args.remainingItems,
    completedItems: args.completedItems,
    gateTimeoutMs: args.resolved.gateTimeoutMs,
    loopSignal: args.abortController.signal,
  });
  if (gateOutcome.iterError !== undefined) iterError = gateOutcome.iterError;
  return { gateResult: gateOutcome.result, iterError };
}

async function refreshOrThrow(lock: PRDLock): Promise<void> {
  // Refresh the lock heartbeat at the top of every iteration so a
  // long-running loop does not look stale to a recovering peer.
  // refresh returns false only if the lock has been broken or
  // taken over by someone else — in that case we MUST stop
  // immediately rather than continue mutating the PRD without
  // exclusivity.
  const refreshed = await refreshPRDLock(lock);
  if (!refreshed) {
    throw new Error(
      `VerifiedLoop: lost PRD lock at ${lock.path} mid-run (lockfile missing, corrupt, or owned by another coordinator)`,
    );
  }
}

async function readPRDOrThrow(prdPath: string): Promise<{ readonly items: readonly PRDItem[] }> {
  const currentPrd = await readPRD(prdPath);
  if (!currentPrd.ok) {
    // PRD became unreadable mid-loop (concurrent overwrite, disk error,
    // or someone deleted it). Same as initial-read failure — surface it.
    throw new Error(
      `VerifiedLoop: PRD became unreadable mid-loop at ${prdPath} (${currentPrd.error.code}): ${currentPrd.error.message}`,
    );
  }
  return currentPrd.value;
}

async function runRunner(
  config: VerifiedLoopConfig,
  promptText: string,
  iterSignal: AbortSignal,
): Promise<{ readonly iterError?: string }> {
  try {
    const input: EngineInput = { kind: "text", text: promptText, signal: iterSignal };
    await drainWithAbort(config.runIteration(input), iterSignal);
    return {};
  } catch (e: unknown) {
    // RunnerStuckError = uncancellable runner; we cannot proceed to
    // verification or the next iteration without risking overlapping
    // work. Surface it as a fatal run-level error.
    if (e instanceof RunnerStuckError) throw e;
    return { iterError: extractMessage(e) };
  }
}

function makeAbortedGateResult(
  iterSignal: AbortSignal,
  iterError: string | undefined,
): VerificationResult {
  // The iteration was aborted, timed out, or the runner threw.
  // Skip verify entirely: a stale workspace can satisfy a file gate
  // (passed:true) and falsely mark the item done despite the runner
  // never completing successfully. Runner crashes/exceptions are
  // just as untrusted as cancellation. Whether this counts against
  // the per-item failure budget is decided below by `cancelled`
  // (loop-level abort = no, runner crash = yes).
  const reason = iterSignal.aborted ? "Iteration aborted/timed out" : "Iteration runner threw";
  return {
    passed: false,
    details: iterError
      ? `${reason} before verification could run: ${iterError}`
      : `${reason} before verification could run`,
  };
}

interface PersistOutcomeArgs {
  readonly resolved: ResolvedConfig;
  readonly lock: PRDLock;
  readonly abortController: AbortController;
  readonly current: PRDItem;
  readonly gateResult: VerificationResult;
  readonly iterError: string | undefined;
  readonly iterSignal: AbortSignal;
  readonly items: readonly PRDItem[];
}

async function persistOutcome(args: PersistOutcomeArgs): Promise<void> {
  // Operator-stop / external-abort is NOT a verification failure. Do not
  // consume the per-item skip budget when the loop is being torn down —
  // a noisy operator who restarts often would otherwise mark unrelated
  // items as skipped. The abortController.signal is the loop-level signal
  // (loop.stop() or external config.signal); a per-call gate timeout
  // fires the local gateSignal but leaves abortController.signal clear.
  const cancelled = args.abortController.signal.aborted;

  if (args.gateResult.passed) {
    await commitCompletion(
      args.resolved.prdPath,
      args.lock,
      args.current.id,
      args.gateResult,
      args.items,
    );
  } else if (!cancelled && args.iterError === undefined && !args.iterSignal.aborted) {
    // Only count a bump when verification actually ran and returned
    // passed:false. Runner aborts/timeouts/throws never reached the
    // gate — treating those as per-item verification failures would
    // let transient infrastructure outages (engine crash, adapter
    // bug, auth hiccup, iteration timeout) accumulate against
    // maxConsecutiveFailures and durably mark untouched work as
    // skipped:true. The iterError/iterSignal-aborted branch above
    // already records gateResult.passed:false in iterationRecords
    // so the run still observes the failure; it just doesn't
    // consume the per-item skip budget.
    await persistFailureBump(
      args.resolved.prdPath,
      args.lock,
      args.current.id,
      args.resolved.maxConsecutiveFailures,
    );
  }
}

async function commitCompletion(
  prdPath: string,
  lock: PRDLock,
  currentId: string,
  gateResult: VerificationResult,
  items: readonly PRDItem[],
): Promise<void> {
  // A passing gate always marks the current item done. itemsCompleted
  // adds *additional* ids (e.g., a single iteration that completes
  // multiple work items). Persisted as ONE atomic write so a crash
  // cannot commit only a prefix of the verified set.
  const requested = [...new Set<string>([currentId, ...(gateResult.itemsCompleted ?? [])])];
  // Filter out ghost ids (gate-API misuse, not a storage error). The
  // current PRD snapshot is items — anything not present there is
  // logged and dropped before the atomic write.
  const validIds = new Set(items.map((it) => it.id));
  const toComplete = requested.filter((id) => {
    if (validIds.has(id)) return true;
    console.warn(`[verified-loop] Failed to mark item "${id}" as done: PRD item not found: ${id}`);
    return false;
  });
  if (toComplete.length === 0) return;
  await persistCompletion(prdPath, lock, toComplete);
}

interface RecordLearningArgs {
  readonly learningsPath: string;
  readonly maxLearningEntries: number;
  readonly iteration: number;
  readonly current: PRDItem;
  readonly gateResult: VerificationResult;
  readonly iterError: string | undefined;
}

async function recordIterationLearning(args: RecordLearningArgs): Promise<void> {
  const learningEntry: LearningsEntry = {
    iteration: args.iteration,
    timestamp: new Date().toISOString(),
    itemId: args.current.id,
    discovered: args.gateResult.passed ? [`Item ${args.current.id} completed`] : [],
    failed: args.iterError
      ? [args.iterError]
      : !args.gateResult.passed
        ? [args.gateResult.details ?? "Gate failed"]
        : [],
    context: `Working on: ${args.current.description}`,
  };
  // Learnings are advisory — never fail the run after PRD state has
  // already been mutated. A learnings disk error here would leave the
  // caller with a thrown run() but the authoritative item state already
  // committed, which is exactly the retry/rollback ambiguity we avoid.
  try {
    await appendLearning(args.learningsPath, learningEntry, args.maxLearningEntries);
  } catch (e: unknown) {
    console.warn(
      `[verified-loop] Failed to append learning entry (non-fatal): ${extractMessage(e)}`,
    );
  }
}

function invokeOnIteration(config: VerifiedLoopConfig, record: IterationRecord): void {
  if (!config.onIteration) return;
  try {
    config.onIteration(record);
  } catch (e: unknown) {
    console.warn(`[verified-loop] onIteration callback threw: ${extractMessage(e)}`);
  }
}
