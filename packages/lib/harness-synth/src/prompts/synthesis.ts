/**
 * Initial synthesis prompt builder. Pure — no I/O, no randomness.
 *
 * The output is a single string consumed by the caller-supplied `generate`
 * callback. Format is a tagged-section block; the parser pairs with this
 * format and is the only consumer of model output.
 */

import type { ForgeCandidate } from "@koi/forge-types";

export interface SynthesisPromptContext {
  readonly candidate: ForgeCandidate;
  readonly targetToolName: string;
  readonly targetToolSchema?: Readonly<Record<string, unknown>> | undefined;
}

const TEMPLATE_HEADER = [
  "You are a code-synthesis assistant for the Koi forge subsystem.",
  "Produce a JavaScript implementation that satisfies the candidate below.",
  "",
  "Respond with a single JSON object — no prose, no fences:",
  '  { "descriptor": { "name": "...", "description": "...", "inputSchema": {...} },',
  '    "code": "...JavaScript source as a JSON string..." }',
  "",
  "The `descriptor.name` field MUST equal the target tool name. The `code`",
  "field is a JSON string, so escape inner quotes and backslashes per JSON",
  "rules — do not wrap source in tags or fences.",
].join("\n");

export function buildSynthesisPrompt(ctx: SynthesisPromptContext): string {
  const schemaBlock = ctx.targetToolSchema
    ? `Target input schema:\n${JSON.stringify(ctx.targetToolSchema)}`
    : "Target input schema: (none specified — propose one)";
  return [
    TEMPLATE_HEADER,
    "",
    `Target tool name: ${ctx.targetToolName}`,
    schemaBlock,
    "",
    "Candidate:",
    `  id: ${ctx.candidate.id}`,
    `  kind: ${ctx.candidate.kind}`,
    `  name: ${ctx.candidate.name}`,
    `  description: ${ctx.candidate.description}`,
    `  scope: ${ctx.candidate.proposedScope}`,
  ].join("\n");
}
