/**
 * Prompt template for iterative refinement of synthesized middleware.
 *
 * Takes the current code + new failure data and asks the LLM to improve.
 */

import type { ToolFailureRecord } from "../types.js";

export interface RefinementPromptContext {
  readonly targetToolName: string;
  readonly currentCode: string;
  readonly newFailures: readonly ToolFailureRecord[];
  readonly iterationNumber: number;
  readonly totalIterations: number;
}

/** Format a single failure for the refinement prompt. */
function formatFailure(f: ToolFailureRecord, index: number): string {
  return [
    `Failure ${index + 1}: [${f.errorCode}] ${f.errorMessage}`,
    `  Parameters: ${JSON.stringify(f.parameters)}`,
  ].join("\n");
}

/**
 * Build the refinement prompt for an iterative improvement cycle.
 *
 * Includes the current code, new failures that occurred despite it,
 * and instructions to fix the gaps.
 */
export function buildRefinementPrompt(ctx: RefinementPromptContext): string {
  const failureSection = ctx.newFailures.map(formatFailure).join("\n\n");

  return `You are improving a middleware that validates tool calls for "${ctx.targetToolName}".

## Current Code (iteration ${ctx.iterationNumber}/${ctx.totalIterations})

\`\`\`typescript
${ctx.currentCode}
\`\`\`

## New Failures (despite the current middleware)

${failureSection}

## Instructions

1. Analyze why the current middleware did not prevent these failures.
2. Modify the code to handle these additional failure patterns.
3. Do NOT remove existing validation logic — extend it.
4. Keep the same export shape: \`createMiddleware()\` returning a \`KoiMiddleware\`.
5. Be concise — only change what's necessary.

Return ONLY the updated TypeScript code block.

\`\`\`typescript
// Updated middleware code here
\`\`\``;
}
