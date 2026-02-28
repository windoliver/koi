/**
 * Generate a TypeScript implementation for a crystallized composite tool.
 *
 * The generated code calls each tool in the n-gram sequence, passing
 * the previous result as context. Parameters are deferred (decision #3A).
 */

import type { CrystallizationCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// Implementation generation
// ---------------------------------------------------------------------------

/**
 * Generate a composite tool implementation string.
 * The generated function accepts a context with a tool executor
 * and calls each tool in sequence, threading results forward.
 */
export function generateCompositeImplementation(candidate: CrystallizationCandidate): string {
  const steps = candidate.ngram.steps;
  const lines: readonly string[] = [
    "// Auto-generated composite tool — crystallized from observed usage patterns",
    `// Pattern: ${steps.map((s) => s.toolId).join(" \u2192 ")} (${String(candidate.occurrences)} occurrences)`,
    "// Parameters deferred — tool-ID-only composition",
    "",
    "export default async function execute(ctx: { readonly executor: (toolId: string, args: unknown) => Promise<unknown> }): Promise<unknown> {",
    ...generateStepLines(steps),
    `  return result_${String(steps.length - 1)};`,
    "}",
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateStepLines(steps: readonly { readonly toolId: string }[]): readonly string[] {
  const lines: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined) continue;
    const varName = `result_${String(i)}`;
    const prevVar = i > 0 ? `result_${String(i - 1)}` : "undefined";
    // justified: mutable local array being constructed, not shared state
    lines.push(
      `  const ${varName} = await ctx.executor(${JSON.stringify(step.toolId)}, ${prevVar});`,
    );
  }

  return lines;
}
