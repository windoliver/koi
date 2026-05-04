import type { StageContext, StageOutcome, VerifierStage } from "./types.js";

/**
 * Built-in stage check signature. Receives the validated frozen artifact
 * snapshot AND the stage context — the second argument carries the
 * `AbortSignal` so the predicate can cooperatively cancel long-running
 * work (compiler, type checker, test runner) instead of blocking until
 * the pipeline notices `signal.aborted` after the fact.
 */
type Check<I> = (artifact: I, ctx: StageContext) => StageOutcome | Promise<StageOutcome>;

function makeStage<I>(name: string, check: Check<I>, version: string): VerifierStage<I> {
  return {
    name,
    version,
    run: (artifact, ctx) => check(artifact, ctx),
  };
}

/**
 * Built-in stage that delegates syntax checking to the supplied predicate.
 * `version` is required — bump it whenever the predicate's semantics change
 * in a way prior cached pass results should be invalidated (compiler
 * upgrade, stricter grammar, etc.).
 */
export function createSyntaxStage<I>(check: Check<I>, version: string): VerifierStage<I> {
  return makeStage("syntax", check, version);
}

/**
 * Built-in stage that delegates type checking to the supplied predicate.
 * `version` is required — bump it when the type checker or its config
 * changes in a way that should re-verify previously passed artifacts.
 */
export function createTypeStage<I>(check: Check<I>, version: string): VerifierStage<I> {
  return makeStage("type", check, version);
}

/**
 * Built-in stage that delegates test execution to the supplied predicate.
 * `version` is required — bump it when the test runner, harness, or
 * assertion semantics change in a way that should re-verify previously
 * passed artifacts.
 */
export function createTestStage<I>(check: Check<I>, version: string): VerifierStage<I> {
  return makeStage("test", check, version);
}
