import type { StageOutcome, VerifierStage } from "./types.js";

type Check<I> = (artifact: I) => StageOutcome | Promise<StageOutcome>;

function makeStage<I>(name: string, check: Check<I>, version?: string): VerifierStage<I> {
  return {
    name,
    ...(version !== undefined ? { version } : {}),
    run: (artifact) => check(artifact),
  };
}

/**
 * Built-in stage that delegates syntax checking to the supplied predicate.
 * Pass a `version` whenever the predicate's semantics change in a way prior
 * cached pass results should be invalidated (compiler upgrade, stricter
 * grammar, etc.).
 */
export function createSyntaxStage<I>(check: Check<I>, version?: string): VerifierStage<I> {
  return makeStage("syntax", check, version);
}

/**
 * Built-in stage that delegates type checking to the supplied predicate.
 * Bump `version` when the type checker or its config changes in a way that
 * should re-verify previously passed artifacts.
 */
export function createTypeStage<I>(check: Check<I>, version?: string): VerifierStage<I> {
  return makeStage("type", check, version);
}

/**
 * Built-in stage that delegates test execution to the supplied predicate.
 * Bump `version` when the test runner, harness, or assertion semantics
 * change in a way that should re-verify previously passed artifacts.
 */
export function createTestStage<I>(check: Check<I>, version?: string): VerifierStage<I> {
  return makeStage("test", check, version);
}
