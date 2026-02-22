/**
 * Stage 3: Self-test — run test cases and pluggable verifiers.
 */

import type { Result } from "@koi/core";
import type { VerificationConfig } from "./config.js";
import type { ForgeError, TestFailure } from "./errors.js";
import { selfTestError } from "./errors.js";
import type {
  ForgeContext,
  ForgeInput,
  ForgeVerifier,
  SandboxExecutor,
  StageReport,
  TestCase,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  // Arrays and objects are not interchangeable
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);

  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

async function runTestCase(
  testCase: TestCase,
  implementation: string,
  executor: SandboxExecutor,
  timeoutMs: number,
): Promise<TestFailure | undefined> {
  const result = await executor.execute(implementation, testCase.input, timeoutMs);

  if (!result.ok) {
    // Sandbox returned a structured error
    if (testCase.shouldThrow === true) {
      return undefined; // Expected to fail
    }
    return {
      testName: testCase.name,
      expected: testCase.expectedOutput,
      actual: undefined,
      error: result.error.message,
    };
  }

  if (testCase.shouldThrow === true) {
    return {
      testName: testCase.name,
      expected: "should throw",
      actual: result.value.output,
      error: "Expected execution to throw, but it succeeded",
    };
  }

  if (
    testCase.expectedOutput !== undefined &&
    !deepEqual(result.value.output, testCase.expectedOutput)
  ) {
    return {
      testName: testCase.name,
      expected: testCase.expectedOutput,
      actual: result.value.output,
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function verifySelfTest(
  input: ForgeInput,
  executor: SandboxExecutor,
  verifiers: readonly ForgeVerifier[],
  context: ForgeContext,
  config: VerificationConfig,
): Promise<Result<StageReport, ForgeError>> {
  const start = performance.now();
  const failures: TestFailure[] = [];

  // Run test cases for tools
  if (input.kind === "tool" && input.testCases !== undefined && input.testCases.length > 0) {
    for (const testCase of input.testCases) {
      const failure = await runTestCase(
        testCase,
        input.implementation,
        executor,
        config.selfTestTimeoutMs,
      );
      if (failure !== undefined) {
        failures.push(failure);
      }
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      error: selfTestError("TEST_FAILED", `${failures.length} test case(s) failed`, failures),
    };
  }

  // Run pluggable verifiers
  for (const verifier of verifiers) {
    const result = await verifier.verify(input, context);
    if (!result.passed) {
      return {
        ok: false,
        error: selfTestError(
          "VERIFIER_REJECTED",
          `Verifier "${verifier.name}" rejected: ${result.message ?? "no reason given"}`,
        ),
      };
    }
  }

  const durationMs = performance.now() - start;
  return {
    ok: true,
    value: { stage: "self_test", passed: true, durationMs },
  };
}
