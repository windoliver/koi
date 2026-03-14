/**
 * Prompt template for initial middleware synthesis from failures.
 *
 * Generates a prompt that instructs the LLM to create a wrapToolCall
 * middleware preventing the observed failure patterns.
 */

import type { QualifiedFailures, ToolFailureRecord } from "../types.js";

export interface SynthesisPromptContext {
  readonly targetToolName: string;
  readonly targetToolSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly failures: QualifiedFailures;
}

/** Format a single failure for inclusion in the prompt. */
function formatFailure(f: ToolFailureRecord, index: number): string {
  const parts = [
    `Failure ${index + 1}:`,
    `  Tool: ${f.toolName}`,
    `  Error: [${f.errorCode}] ${f.errorMessage}`,
    `  Parameters: ${JSON.stringify(f.parameters)}`,
  ];
  if (f.agentGoal !== undefined) {
    parts.push(`  Agent goal: ${f.agentGoal}`);
  }
  return parts.join("\n");
}

/**
 * Build the synthesis prompt from failure context.
 *
 * The prompt instructs the LLM to generate TypeScript middleware code
 * with a specific export shape: `{ descriptor, factory }`.
 */
export function buildSynthesisPrompt(ctx: SynthesisPromptContext): string {
  const failureSection = ctx.failures.failures.map(formatFailure).join("\n\n");

  const schemaSection =
    ctx.targetToolSchema !== undefined
      ? `\nTool schema:\n\`\`\`json\n${JSON.stringify(ctx.targetToolSchema, null, 2)}\n\`\`\`\n`
      : "";

  return `You are a middleware code generator for an agent runtime.

## Task
Generate a TypeScript \`wrapToolCall\` middleware that prevents the following observed failures for the tool "${ctx.targetToolName}".
${schemaSection}
## Observed Failures (${ctx.failures.failures.length} distinct, ${ctx.failures.clusterCount} error patterns)

${failureSection}

## Requirements

1. Export a single function \`createMiddleware\` that returns a \`KoiMiddleware\` object.
2. The middleware must implement \`wrapToolCall(ctx, req, next)\`.
3. It should validate tool call parameters BEFORE calling \`next(req)\`.
4. If validation fails, return an error response WITHOUT calling the tool.
5. If validation passes, call \`next(req)\` and return the result.
6. The middleware should ONLY intercept calls to "${ctx.targetToolName}".
7. For all other tools, pass through by calling \`next(req)\`.

## Output Format

Return ONLY the TypeScript code block. No explanation.

\`\`\`typescript
export function createMiddleware() {
  return {
    name: "harness-${ctx.targetToolName}",
    priority: 180,
    phase: "INTERCEPT" as const,
    async wrapToolCall(ctx, req, next) {
      if (req.toolName !== "${ctx.targetToolName}") return next(req);
      // ... validation logic based on failure patterns ...
      return next(req);
    },
  };
}
\`\`\``;
}
