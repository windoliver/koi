/**
 * Gate execution for one verified-loop iteration.
 *
 * Owns the gate timeout/abort race, GateInfrastructureError /
 * GateQuiescenceError handling, and the post-timeout quiescence
 * grace window.
 */

import { extractMessage } from "@koi/errors";
import { GateInfrastructureError, GateQuiescenceError } from "./gates.js";
import { RunnerStuckError } from "./runner-drain.js";
import type {
  GateContext,
  IterationRecord,
  LearningsEntry,
  PRDItem,
  VerificationFn,
  VerificationResult,
} from "./types.js";

const GATE_QUIESCE_TIMEOUT_MS = 5_000;

export interface RunGateArgs {
  readonly verify: VerificationFn;
  readonly iteration: number;
  readonly currentItem: PRDItem;
  readonly workingDir: string;
  readonly iterationRecords: readonly IterationRecord[];
  readonly learnings: readonly LearningsEntry[];
  readonly remainingItems: readonly PRDItem[];
  readonly completedItems: readonly PRDItem[];
  readonly gateTimeoutMs: number;
  readonly loopSignal: AbortSignal;
}

export interface GateOutcome {
  readonly result: VerificationResult;
  readonly iterError?: string;
}

/** Run the configured gate for one iteration with timeout + abort handling. */
export async function runGate(args: RunGateArgs): Promise<GateOutcome> {
  // Hold the timeout signal separately from the composed gateSignal
  // so we can distinguish "gate timed out" from "operator stopped
  // the loop during verify". The latter is allowed to commit if the
  // verifier returns passed:true (the gate did its work; the user
  // just asked the loop to wind down). The former must NEVER commit
  // because the verifier ran past its budget and any returned
  // passed:true is racing the timeout.
  const gateTimeoutSignal = AbortSignal.timeout(args.gateTimeoutMs);
  const gateSignal = AbortSignal.any([args.loopSignal, gateTimeoutSignal]);
  // Fail-fast if the loop has already been aborted before we
  // even invoke the gate. Otherwise verify() may run, resolve
  // {passed:true}, and slip past the abort race below (the
  // timeoutPromise listener is attached AFTER verify is called
  // — a synchronously-resolving gate would never observe it).
  if (gateSignal.aborted) {
    return { result: { passed: false, details: "Gate aborted before start" } };
  }

  const ctx: GateContext = {
    iteration: args.iteration,
    currentItem: args.currentItem,
    workingDir: args.workingDir,
    iterationRecords: [...args.iterationRecords],
    learnings: args.learnings,
    remainingItems: args.remainingItems,
    completedItems: args.completedItems,
    signal: gateSignal,
  };

  const gatePromise = invokeVerify(args.verify, ctx);
  return await raceGate(gatePromise, gateSignal, gateTimeoutSignal, args.gateTimeoutMs);
}

function invokeVerify(verify: VerificationFn, ctx: GateContext): Promise<VerificationResult> {
  // Catch synchronous throws while building the verifier promise
  // (missing dep, bad context, local validation) so they degrade
  // to a failed gate result instead of crashing the run. Don't
  // use Promise.resolve().then(...) here — that adds a microtask
  // delay that breaks the immediate-abort path in verify().
  try {
    // GateQuiescenceError thrown synchronously from verify()
    // must propagate as fatal — see the catch path on the
    // race below for the async-throw equivalent.
    return Promise.resolve(verify(ctx));
  } catch (e: unknown) {
    return Promise.reject(e);
  }
}

async function raceGate(
  gatePromise: Promise<VerificationResult>,
  gateSignal: AbortSignal,
  gateTimeoutSignal: AbortSignal,
  gateTimeoutMs: number,
): Promise<GateOutcome> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      gateSignal.addEventListener("abort", () => reject(new Error("Gate timed out")), {
        once: true,
      });
    });
    const result = await Promise.race([gatePromise, timeoutPromise]);
    // Defense-in-depth: a cooperative verifier that listens for
    // ctx.signal can resolve {passed:true} during its abort
    // handler and beat the timeoutPromise rejection in the race.
    // After winning, that result would flow into markDoneMany
    // even though the gate timed out. Force passed:false when
    // the local timeout fired regardless of who won the race.
    // (We do NOT do this for abortController.signal — operator
    // stop during verify is an intentional shutdown and a
    // verifier returning passed:true is allowed to commit.)
    if (gateTimeoutSignal.aborted && result.passed) {
      return {
        result: {
          passed: false,
          details: `Gate timed out (${gateTimeoutMs}ms); refusing to honor late passed:true result`,
        },
      };
    }
    return { result };
  } catch (e: unknown) {
    return await handleGateError(e, gatePromise);
  }
}

async function handleGateError(
  e: unknown,
  gatePromise: Promise<VerificationResult>,
): Promise<GateOutcome> {
  // GateQuiescenceError = the gate's subprocess tree could
  // not be proven dead. Continuing to the next iteration
  // would let leftover children mutate the workspace under
  // overlapping verification — exactly what the loop is
  // supposed to prevent. Surface as fatal.
  if (e instanceof GateQuiescenceError) throw e;
  // GateInfrastructureError (spawn ENOENT/EACCES/etc.) means
  // the verifier never ran — treat it like an iteration
  // runner failure so it does not consume the per-item skip
  // budget. Record it as iterError + passed:false so the
  // result is observable but the "did real verification fail
  // for this item?" predicate stays false.
  if (e instanceof GateInfrastructureError) {
    return {
      result: {
        passed: false,
        details: `Gate could not be executed (infrastructure failure): ${e.message}`,
      },
      iterError: `Gate infrastructure failure: ${e.message}`,
    };
  }
  // Gate timed out or aborted. The gate's promise is still in
  // flight unless it cooperatively settles after seeing
  // gateSignal abort. Wait for quiescence with a bounded grace
  // budget; if the gate refuses to settle, fail the run fatally
  // — continuing while a verification call is still mutating
  // external systems would produce overlapping work.
  await waitForGateQuiescence(gatePromise);
  return { result: { passed: false, details: `Gate error: ${extractMessage(e)}` } };
}

async function waitForGateQuiescence(gatePromise: Promise<VerificationResult>): Promise<void> {
  // Use let — justified: race outcome flag.
  let gateStuck = false;
  const settled = gatePromise.then(
    () => undefined,
    () => undefined,
  );
  const grace = new Promise<void>((resolve) => {
    setTimeout(() => {
      gateStuck = true;
      resolve();
    }, GATE_QUIESCE_TIMEOUT_MS).unref?.();
  });
  await Promise.race([settled, grace]);
  if (gateStuck) {
    throw new RunnerStuckError(
      `VerifiedLoop: gate did not quiesce within ${GATE_QUIESCE_TIMEOUT_MS}ms after timeout/abort; aborting run to avoid overlapping verification work`,
    );
  }
}
