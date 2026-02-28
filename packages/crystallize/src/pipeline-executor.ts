/**
 * Generic pipeline executor for crystallized composite tools.
 *
 * Provides a shared runtime helper that composite tools call to execute
 * their tool steps in sequence, threading results forward.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single step in a pipeline. */
export interface PipelineStep {
  readonly toolId: string;
}

/** Result of executing a pipeline — discriminated union. */
export type PipelineResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly partialResults: readonly unknown[];
    }
  | {
      readonly ok: false;
      readonly failedAtStep: number;
      readonly partialResults: readonly unknown[];
      readonly error: string;
    };

/** Tool executor signature injected by the runtime. */
export interface PipelineExecutor {
  readonly executor: (toolId: string, args: unknown) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Runtime helper
// ---------------------------------------------------------------------------

/**
 * Execute a pipeline of tool steps in sequence, threading results forward.
 * First step receives `firstToolArgs` (or undefined). Each subsequent step
 * receives the previous step's result.
 *
 * Returns a PipelineResult with partial results on failure.
 */
export async function executePipeline(
  steps: readonly PipelineStep[],
  ctx: PipelineExecutor,
  firstToolArgs?: unknown,
): Promise<PipelineResult> {
  if (steps.length === 0) {
    return { ok: true, value: undefined, partialResults: [] };
  }

  const partialResults: unknown[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined) {
      return {
        ok: false,
        failedAtStep: i,
        partialResults,
        error: `Step ${String(i)} is undefined`,
      };
    }

    const input = i === 0 ? firstToolArgs : partialResults[i - 1];

    try {
      const result = await ctx.executor(step.toolId, input);
      // justified: mutable local array being constructed, not shared state
      partialResults.push(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        failedAtStep: i,
        partialResults,
        error: `Step ${String(i)} (${step.toolId}) failed: ${message}`,
      };
    }
  }

  return {
    ok: true,
    value: partialResults[partialResults.length - 1],
    partialResults,
  };
}

// ---------------------------------------------------------------------------
// Code generation helper
// ---------------------------------------------------------------------------

/**
 * Generate the import statement and call to executePipeline for composite tools.
 * Used by generate-composite.ts to produce cleaner generated code.
 */
export function generatePipelineExecutorCode(
  steps: readonly PipelineStep[],
  occurrences: number,
): string {
  const stepsJson = JSON.stringify(steps.map((s) => ({ toolId: s.toolId })));
  const pattern = steps.map((s) => s.toolId).join(" \u2192 ");
  const lines: readonly string[] = [
    "// Auto-generated composite tool \u2014 crystallized from observed usage patterns",
    `// Pattern: ${pattern} (${String(occurrences)} occurrences)`,
    "// Uses shared pipeline executor for reliable step-by-step execution",
    "",
    'import { executePipeline } from "@koi/crystallize/pipeline-executor";',
    "",
    `const STEPS = ${stepsJson} as const;`,
    "",
    "export default async function execute(",
    "  ctx: { readonly executor: (toolId: string, args: unknown) => Promise<unknown> },",
    "  firstToolArgs?: unknown,",
    "): Promise<unknown> {",
    "  const result = await executePipeline(STEPS, ctx, firstToolArgs);",
    "  if (!result.ok) {",
    `    throw new Error(result.error ?? "Pipeline failed at step " + String(result.failedAtStep));`,
    "  }",
    "  return result.value;",
    "}",
  ];
  return lines.join("\n");
}
