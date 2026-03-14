/**
 * Main synthesis entry point.
 *
 * Orchestrates: prompt building → LLM call → output parsing.
 * Single-shot synthesis (no iteration — that's harness-search's job).
 */

import { parseSynthesisOutput } from "./parser.js";
import { buildSynthesisPrompt } from "./prompts/synthesis.js";
import type { GenerateCallback, SynthesisInput, SynthesisResult } from "./types.js";

/**
 * Synthesize middleware code from qualified failure data.
 *
 * Makes a single LLM call. Iteration/refinement is handled by
 * harness-search (separate L2 package). This function is the
 * atomic unit of synthesis.
 *
 * @param input - Qualified failures + target tool info
 * @param generate - LLM callback (injected by L3 wiring)
 * @returns Parsed synthesis output or error reason
 */
export async function synthesize(
  input: SynthesisInput,
  generate: GenerateCallback,
): Promise<SynthesisResult> {
  const prompt = buildSynthesisPrompt({
    targetToolName: input.targetToolName,
    targetToolSchema: input.targetToolSchema,
    failures: input.failures,
  });

  let raw: string;
  try {
    raw = await generate(prompt);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `LLM generation failed: ${message}` };
  }

  const parsed = parseSynthesisOutput(raw, input.targetToolName);
  if (!parsed.ok) {
    return parsed;
  }

  return {
    ok: true,
    value: {
      code: parsed.value.code,
      descriptor: parsed.value.descriptor,
      iterationCount: 1,
    },
  };
}
