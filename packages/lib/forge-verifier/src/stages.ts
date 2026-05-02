import type { StageOutcome, VerifierStage } from "./types.js";

type Check<I> = (artifact: I) => StageOutcome | Promise<StageOutcome>;

function makeStage<I>(name: string, check: Check<I>): VerifierStage<I> {
  return {
    name,
    run: (artifact) => check(artifact),
  };
}

/** Built-in stage that delegates syntax checking to the supplied predicate. */
export function createSyntaxStage<I>(check: Check<I>): VerifierStage<I> {
  return makeStage("syntax", check);
}

/** Built-in stage that delegates type checking to the supplied predicate. */
export function createTypeStage<I>(check: Check<I>): VerifierStage<I> {
  return makeStage("type", check);
}

/** Built-in stage that delegates test execution to the supplied predicate. */
export function createTestStage<I>(check: Check<I>): VerifierStage<I> {
  return makeStage("test", check);
}
