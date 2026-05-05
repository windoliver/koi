/**
 * Refinement prompt builder. Used on retry — carries the prior attempt
 * plus the failure reason so the model can correct its previous output.
 *
 * Pure: same `(input) -> string` contract as the synthesis prompt.
 */

import type { ForgeCandidate } from "@koi/forge-types";

export interface RefinementPromptContext {
  readonly candidate: ForgeCandidate;
  readonly targetToolName: string;
  readonly targetToolSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly priorCode: string;
  readonly priorReason: string;
  readonly attempt: number;
}

const TEMPLATE_HEADER = [
  "Your previous attempt failed verification. Produce a corrected",
  "implementation, keeping the same response format:",
  '  <descriptor>{ "name": "...", "description": "...", "inputSchema": { ... } }</descriptor>',
  "  <code>// JavaScript source</code>",
].join("\n");

export function buildRefinementPrompt(ctx: RefinementPromptContext): string {
  const schemaBlock = ctx.targetToolSchema
    ? `Target input schema:\n${JSON.stringify(ctx.targetToolSchema)}`
    : "Target input schema: (none specified — propose one)";
  return [
    TEMPLATE_HEADER,
    "",
    `Attempt: ${ctx.attempt}`,
    `Target tool name: ${ctx.targetToolName}`,
    schemaBlock,
    "",
    "Candidate:",
    `  id: ${ctx.candidate.id}`,
    `  kind: ${ctx.candidate.kind}`,
    `  description: ${ctx.candidate.description}`,
    "",
    "Previous failure reason:",
    `  ${ctx.priorReason}`,
    "",
    "Previous code (for reference — fix or replace):",
    "<prior>",
    ctx.priorCode,
    "</prior>",
  ].join("\n");
}
