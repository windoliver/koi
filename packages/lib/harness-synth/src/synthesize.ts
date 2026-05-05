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

import { linkSignal, redactReason, safeSanitize } from "./guarded-attempt.js";
import { validateAndSnapshotInput } from "./input-validation.js";
import { jsonEqual } from "./json-plain.js";
import { parseSynthesisOutput } from "./parser.js";
import { buildRefinementPrompt } from "./prompts/refinement.js";
import { buildSynthesisPrompt } from "./prompts/synthesis.js";
import { safeGenerate, safeVerify } from "./safe-callbacks.js";
import {
  DEFAULT_SYNTHESIS_CONFIG,
  FORGED_BY,
  type SynthesisConfig,
  type SynthesisFailureKind,
  type SynthesisInput,
  type SynthesisResult,
} from "./types.js";
import { freezeDescriptor } from "./verify-coerce.js";

export type SynthesisInitConfig = Partial<SynthesisConfig> &
  Pick<SynthesisConfig, "generate" | "verify" | "adapterHonorsAbort">;

/** Hard cap on a single LLM response (256 KB). */
const MAX_GENERATED_BYTES = 256 * 1024;

/** Hard cap on prior code carried into the next refinement prompt. */
const MAX_PRIOR_CODE_BYTES = 8 * 1024;

export async function synthesize(
  input: SynthesisInput,
  config: SynthesisInitConfig,
): Promise<SynthesisResult> {
  const cfg = validateConfig(config);
  if (!cfg.ok) return cfg.failure;
  const validated = validateAndSnapshotInput(input);
  if (!validated.ok) return validated.failure;
  return await runSynthesisLoop(validated.value, cfg.value);
}

interface ResolvedConfig {
  readonly generate: SynthesisConfig["generate"];
  readonly verify: SynthesisConfig["verify"];
  readonly maxAttempts: number;
  readonly attemptTimeoutMs: number;
  readonly adapterHonorsAbort: boolean;
  readonly clock: () => number;
  readonly signal: AbortSignal | undefined;
  readonly sanitizeVerifierReason: (reason: string) => string;
}

function validateConfig(
  config: SynthesisInitConfig,
):
  | { readonly ok: true; readonly value: ResolvedConfig }
  | { readonly ok: false; readonly failure: Extract<SynthesisResult, { ok: false }> } {
  const requestedAttempts = config.maxAttempts ?? DEFAULT_SYNTHESIS_CONFIG.maxAttempts;
  if (!Number.isInteger(requestedAttempts) || requestedAttempts < 1) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "maxAttempts must be a positive integer",
        attempts: 0,
        kind: "config_invalid",
      },
    };
  }
  const adapterHonorsAbort = config.adapterHonorsAbort;
  if (adapterHonorsAbort !== true && adapterHonorsAbort !== false) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "adapterHonorsAbort must be a boolean",
        attempts: 0,
        kind: "config_invalid",
      },
    };
  }
  const attemptTimeoutMs = config.attemptTimeoutMs ?? DEFAULT_SYNTHESIS_CONFIG.attemptTimeoutMs;
  if (
    typeof attemptTimeoutMs !== "number" ||
    Number.isNaN(attemptTimeoutMs) ||
    attemptTimeoutMs <= 0
  ) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "attemptTimeoutMs must be a positive finite number or Infinity",
        attempts: 0,
        kind: "config_invalid",
      },
    };
  }
  return {
    ok: true,
    value: {
      generate: config.generate,
      verify: config.verify,
      // Best-effort mode forces single-shot so the loop never starts a
      // second attempt while a prior one may still be in flight.
      maxAttempts: adapterHonorsAbort ? requestedAttempts : 1,
      attemptTimeoutMs,
      adapterHonorsAbort,
      clock: config.clock ?? DEFAULT_SYNTHESIS_CONFIG.clock,
      signal: config.signal,
      sanitizeVerifierReason:
        config.sanitizeVerifierReason ?? DEFAULT_SYNTHESIS_CONFIG.sanitizeVerifierReason,
    },
  };
}

async function runSynthesisLoop(
  safeInput: SynthesisInput,
  cfg: ResolvedConfig,
): Promise<SynthesisResult> {
  let priorCode = "";
  let priorReason = "";
  let lastReason = "no attempts ran";
  // Coarse failure category tracked alongside lastReason so the final
  // exhaustion return carries the most-recent failure's structured kind
  // even after the human-readable reason has been redacted.
  let lastKind: SynthesisFailureKind = "generate_exception";

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    if (cfg.signal?.aborted) {
      return {
        ok: false,
        reason: "Synthesis aborted by caller",
        attempts: attempt - 1,
        kind: "synthesis_aborted",
      };
    }
    const prompt = buildPromptForAttempt(safeInput, attempt, priorCode, priorReason);
    const attemptController = new AbortController();
    const detach = linkSignal(cfg.signal, attemptController);
    const attemptStart = cfg.clock();
    const remainingMs = (): number => {
      if (!Number.isFinite(cfg.attemptTimeoutMs)) return cfg.attemptTimeoutMs;
      const used = cfg.clock() - attemptStart;
      return Math.max(0, cfg.attemptTimeoutMs - used);
    };
    try {
      const outcome = await runAttempt(safeInput, cfg, prompt, remainingMs, attemptController);
      if (outcome.ok) {
        return {
          ok: true,
          value: { ...outcome.success.value, attempts: attempt },
        };
      }
      // Update loop state for next iteration / final return.
      lastReason = outcome.lastReason;
      lastKind = outcome.lastKind;
      priorCode = outcome.priorCode;
      priorReason = outcome.priorReason;
      if (outcome.terminal) {
        return {
          ok: false,
          reason: lastReason,
          attempts: attempt,
          kind: lastKind,
        };
      }
    } finally {
      attemptController.abort();
      detach();
    }
  }
  return { ok: false, reason: lastReason, attempts: cfg.maxAttempts, kind: lastKind };
}

function buildPromptForAttempt(
  safeInput: SynthesisInput,
  attempt: number,
  priorCode: string,
  priorReason: string,
): string {
  if (attempt === 1) {
    return buildSynthesisPrompt({
      candidate: safeInput.candidate,
      targetToolName: safeInput.targetToolName,
      targetToolSchema: safeInput.targetToolSchema,
    });
  }
  return buildRefinementPrompt({
    candidate: safeInput.candidate,
    targetToolName: safeInput.targetToolName,
    targetToolSchema: safeInput.targetToolSchema,
    priorCode,
    priorReason,
    attempt,
  });
}

interface AttemptFailure {
  readonly ok: false;
  readonly lastReason: string;
  readonly lastKind: SynthesisFailureKind;
  readonly priorCode: string;
  readonly priorReason: string;
  /** When `true`, exit the loop without trying further attempts. */
  readonly terminal: boolean;
}
type AttemptOutcome =
  | { readonly ok: true; readonly success: Extract<SynthesisResult, { ok: true }> }
  | AttemptFailure;

async function runAttempt(
  safeInput: SynthesisInput,
  cfg: ResolvedConfig,
  prompt: string,
  remainingMs: () => number,
  attemptController: AbortController,
): Promise<AttemptOutcome> {
  const generated = await safeGenerate(
    cfg.generate,
    prompt,
    remainingMs(),
    attemptController,
    cfg.adapterHonorsAbort,
  );
  if (!generated.ok) {
    const safeReason = generated.tainted
      ? safeSanitize(cfg.sanitizeVerifierReason, generated.reason)
      : generated.reason;
    const extra =
      !cfg.adapterHonorsAbort && /timed out|aborted by caller/.test(generated.reason)
        ? " (adapter may still be running)"
        : "";
    return {
      ok: false,
      lastReason: safeReason + extra,
      lastKind: generated.failureKind ?? "generate_exception",
      priorCode: "",
      priorReason: redactReason(safeReason),
      terminal: generated.aborted === true,
    };
  }

  // Reject oversized model output BEFORE parsing. The brace scanner is
  // O(n) per `{` candidate in the worst case, so a multi-megabyte
  // brace-heavy response could burn unbounded CPU on the main thread.
  if (generated.value.length > MAX_GENERATED_BYTES) {
    const reason = `Generated output exceeds ${MAX_GENERATED_BYTES} bytes (got ${generated.value.length})`;
    return {
      ok: false,
      lastReason: reason,
      lastKind: "generate_oversized",
      priorCode: "",
      priorReason: redactReason(reason),
      terminal: false,
    };
  }

  const parsed = parseSynthesisOutput(generated.value, safeInput.targetToolName);
  if (!parsed.ok) {
    return {
      ok: false,
      lastReason: parsed.reason,
      lastKind: "parse_failed",
      priorCode: capPriorCode(generated.value),
      priorReason: redactReason(parsed.reason),
      terminal: false,
    };
  }

  const schemaCheck = checkSchemaMatch(
    parsed.value.descriptor.inputSchema,
    safeInput.targetToolSchema,
  );
  if (!schemaCheck.ok) {
    return {
      ok: false,
      lastReason: schemaCheck.reason,
      lastKind: "schema_mismatch",
      priorCode: capPriorCode(parsed.value.code),
      priorReason: redactReason(schemaCheck.reason),
      terminal: false,
    };
  }

  return await runVerifyStage(safeInput, cfg, parsed.value, remainingMs, attemptController);
}

async function runVerifyStage(
  safeInput: SynthesisInput,
  cfg: ResolvedConfig,
  parsed: { readonly code: string; readonly descriptor: import("@koi/core").ToolDescriptor },
  remainingMs: () => number,
  attemptController: AbortController,
): Promise<AttemptOutcome> {
  // Freeze a deep copy of the descriptor before handing it to the verifier
  // and again before returning. Cloning isolates the verify boundary;
  // freezing catches post-return mutation by a downstream caller.
  const verifierDescriptor = freezeDescriptor(parsed.descriptor);
  const verified = await safeVerify(
    cfg.verify,
    parsed.code,
    verifierDescriptor,
    remainingMs(),
    attemptController,
    cfg.adapterHonorsAbort,
  );
  if (!verified.ok) {
    const safeReason = verified.tainted
      ? safeSanitize(cfg.sanitizeVerifierReason, verified.reason)
      : verified.reason;
    const verifyExtra =
      !cfg.adapterHonorsAbort && /timed out|aborted by caller/.test(verified.reason)
        ? " (adapter may still be running)"
        : "";
    return {
      ok: false,
      lastReason: safeReason + verifyExtra,
      lastKind: verified.failureKind ?? "verify_exception",
      priorCode: capPriorCode(parsed.code),
      priorReason: redactReason(safeReason),
      terminal: verified.aborted === true,
    };
  }

  // Re-validate the descriptor that will actually be returned, in case
  // the verifier mutated the frozen-but-aliased object.
  const finalDescriptor = freezeDescriptor(verifierDescriptor);
  if (finalDescriptor.name !== safeInput.targetToolName) {
    return {
      ok: false,
      lastReason: "Verifier mutated descriptor.name post-verification",
      lastKind: "verify_post_mutation",
      priorCode: "",
      priorReason: "",
      terminal: true,
    };
  }
  if (!checkSchemaMatch(finalDescriptor.inputSchema, safeInput.targetToolSchema).ok) {
    return {
      ok: false,
      lastReason: "Verifier mutated descriptor.inputSchema post-verification",
      lastKind: "verify_post_mutation",
      priorCode: "",
      priorReason: "",
      terminal: true,
    };
  }
  return {
    ok: true,
    success: {
      ok: true,
      value: {
        code: parsed.code,
        descriptor: finalDescriptor,
        attempts: 0, // patched by caller
        forgedBy: FORGED_BY,
        synthesizedAt: cfg.clock(),
        verification: verified.summary,
      },
    },
  };
}

/**
 * Truncate prior code before forwarding to the LLM in the refinement
 * prompt. A failed attempt would otherwise replay its full code into
 * every subsequent attempt, blowing up token cost.
 */
function capPriorCode(code: string): string {
  if (code.length <= MAX_PRIOR_CODE_BYTES) return code;
  const head = code.slice(0, MAX_PRIOR_CODE_BYTES);
  return `${head}\n/* …truncated ${code.length - MAX_PRIOR_CODE_BYTES} bytes */`;
}

function checkSchemaMatch(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (jsonEqual(actual, expected)) return { ok: true };
  return {
    ok: false,
    reason: "Synthesized descriptor.inputSchema does not match targetToolSchema",
  };
}
