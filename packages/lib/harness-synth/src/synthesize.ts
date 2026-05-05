/**
 * Main synthesis entry point.
 *
 * Runs `prompt → generate → parse → verify`. On parse-fail OR verify-fail,
 * builds a refinement prompt that carries the prior code and failure reason,
 * then re-enters the loop. Terminates after `maxAttempts` cycles or on the
 * first verified parse — whichever comes first.
 *
 * No I/O: both `generate` and `verify` are caller-injected callbacks.
 */

import { parseSynthesisOutput } from "./parser.js";
import { buildRefinementPrompt } from "./prompts/refinement.js";
import { buildSynthesisPrompt } from "./prompts/synthesis.js";
import {
  DEFAULT_SYNTHESIS_CONFIG,
  FORGED_BY,
  type SynthesisConfig,
  type SynthesisInput,
  type SynthesisResult,
} from "./types.js";

export type SynthesisInitConfig = Partial<SynthesisConfig> &
  Pick<SynthesisConfig, "generate" | "verify">;

export async function synthesize(
  input: SynthesisInput,
  config: SynthesisInitConfig,
): Promise<SynthesisResult> {
  const maxAttempts = config.maxAttempts ?? DEFAULT_SYNTHESIS_CONFIG.maxAttempts;
  if (maxAttempts < 1) {
    return { ok: false, reason: "maxAttempts must be >= 1", attempts: 0 };
  }
  const clock = config.clock ?? DEFAULT_SYNTHESIS_CONFIG.clock;

  let priorCode = "";
  let priorReason = "";
  let lastReason = "no attempts ran";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt =
      attempt === 1
        ? buildSynthesisPrompt({
            candidate: input.candidate,
            targetToolName: input.targetToolName,
            targetToolSchema: input.targetToolSchema,
          })
        : buildRefinementPrompt({
            candidate: input.candidate,
            targetToolName: input.targetToolName,
            targetToolSchema: input.targetToolSchema,
            priorCode,
            priorReason,
            attempt,
          });

    const generated = await safeGenerate(config.generate, prompt);
    if (!generated.ok) {
      lastReason = generated.reason;
      priorReason = generated.reason;
      priorCode = "";
      continue;
    }

    const parsed = parseSynthesisOutput(generated.value, input.targetToolName);
    if (!parsed.ok) {
      lastReason = parsed.reason;
      priorReason = parsed.reason;
      priorCode = generated.value;
      continue;
    }

    const verified = await Promise.resolve(
      config.verify(parsed.value.code, parsed.value.descriptor),
    );
    if (!verified.ok) {
      lastReason = verified.reason;
      priorReason = verified.reason;
      priorCode = parsed.value.code;
      continue;
    }

    return {
      ok: true,
      value: {
        code: parsed.value.code,
        descriptor: parsed.value.descriptor,
        attempts: attempt,
        forgedBy: FORGED_BY,
        synthesizedAt: clock(),
      },
    };
  }

  return { ok: false, reason: lastReason, attempts: maxAttempts };
}

async function safeGenerate(
  generate: SynthesisConfig["generate"],
  prompt: string,
): Promise<{ ok: true; value: string } | { ok: false; reason: string }> {
  try {
    const value = await generate(prompt);
    return { ok: true, value };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `LLM generation failed: ${message}` };
  }
}
