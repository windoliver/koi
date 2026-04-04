/**
 * Exfiltration guard middleware — scans tool inputs and model output
 * for secret exfiltration attempts (base64/URL-encoded or raw secrets).
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelStreamHandler,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import {
  createAllSecretPatterns,
  createDecodingDetectors,
  createRedactor,
  type Redactor,
  type SecretPattern,
} from "@koi/redaction";

import type { ExfiltrationEvent, ExfiltrationGuardConfig } from "./config.js";
import { validateExfiltrationGuardConfig } from "./config.js";

const CAPABILITY_LABEL = "exfiltration-guard";

/**
 * Create an exfiltration guard middleware that scans tool I/O and model
 * output for secret patterns, including encoded variants.
 *
 * Priority: 50 (runs before permissions at 100).
 * Phase: "intercept" (mutates or blocks requests).
 */
export function createExfiltrationGuardMiddleware(
  configInput?: Partial<ExfiltrationGuardConfig>,
): KoiMiddleware {
  const validationResult = validateExfiltrationGuardConfig(configInput);
  if (!validationResult.ok) {
    throw new Error(`Invalid ExfiltrationGuardConfig: ${validationResult.error.message}`);
  }
  const config = validationResult.value;

  // Build composite pattern set: 13 built-in + 2 decoding wrappers + custom
  const patterns: readonly SecretPattern[] = [
    ...createAllSecretPatterns(),
    ...createDecodingDetectors(),
    ...config.customPatterns,
  ];

  const redactor: Redactor = createRedactor({ patterns });

  function fireDetection(event: ExfiltrationEvent): void {
    if (config.onDetection !== undefined) {
      try {
        config.onDetection(event);
      } catch {
        // Swallow observer errors — never let telemetry break the pipeline
      }
    }
  }

  return {
    name: CAPABILITY_LABEL,
    priority: 50,
    phase: "intercept",

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return {
        label: CAPABILITY_LABEL,
        description: `Scanning tool I/O and model output for secret exfiltration (action: ${config.action})`,
      };
    },

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      if (!config.scanToolInput) {
        return next(request);
      }

      const result = redactor.redactObject(request.input);

      // Fail-closed: redaction engine failure (secretCount === -1)
      if (result.secretCount === -1) {
        fireDetection({
          location: "tool-input",
          toolId: request.toolId,
          matchCount: 0,
          kinds: ["redaction_failure"],
          action: "block",
        });
        return {
          output: {
            error: "Exfiltration guard: redaction engine failure — request blocked (fail-closed)",
            code: "INTERNAL",
          },
        };
      }

      if (result.secretCount > 0) {
        // Extract unique kinds from the redacted output diff
        const kinds = extractKindsFromRedaction(request.input, result.value);

        fireDetection({
          location: "tool-input",
          toolId: request.toolId,
          matchCount: result.secretCount,
          kinds,
          action: config.action,
        });

        if (config.action === "block") {
          return {
            output: {
              error: `Exfiltration guard: ${String(result.secretCount)} secret(s) detected in tool input — request blocked`,
              code: "PERMISSION",
            },
          };
        }

        if (config.action === "redact") {
          return next({ ...request, input: result.value });
        }

        // "warn" — pass through unchanged
      }

      return next(request);
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      if (!config.scanModelOutput) {
        yield* next(request);
        return;
      }

      // let justified: accumulates text deltas for scanning
      let buffer = "";
      // let justified: tracks whether we've already scanned and acted
      let scanned = false;

      for await (const chunk of next(request)) {
        if (chunk.kind === "text_delta") {
          buffer += chunk.delta;

          // Cap buffer to prevent memory pressure
          if (buffer.length > config.maxStringLength) {
            if (config.action === "block") {
              fireDetection({
                location: "model-output",
                matchCount: 0,
                kinds: ["buffer_overflow"],
                action: "block",
              });
              yield {
                kind: "error",
                message:
                  "Exfiltration guard: model output exceeded scan buffer — blocked (fail-closed)",
                code: "INTERNAL",
                retryable: false,
              };
              return;
            }
            // For warn/redact, just stop accumulating and yield remainder unscanned
            yield chunk;
            continue;
          }

          // Buffer text deltas — don't yield yet, scan on done
          continue;
        }

        if (chunk.kind === "done" && !scanned) {
          scanned = true;

          if (buffer.length > 0) {
            const result = redactor.redactString(buffer);

            // Fail-closed on redaction failure
            if (result.matchCount === -1) {
              fireDetection({
                location: "model-output",
                matchCount: 0,
                kinds: ["redaction_failure"],
                action: "block",
              });
              yield {
                kind: "error",
                message:
                  "Exfiltration guard: redaction engine failure on model output — blocked (fail-closed)",
                code: "INTERNAL",
                retryable: false,
              };
              return;
            }

            if (result.matchCount > 0) {
              fireDetection({
                location: "model-output",
                matchCount: result.matchCount,
                kinds: [],
                action: config.action,
              });

              if (config.action === "block") {
                yield {
                  kind: "error",
                  message: `Exfiltration guard: ${String(result.matchCount)} secret(s) detected in model output — blocked`,
                  code: "PERMISSION",
                  retryable: false,
                };
                return;
              }

              if (config.action === "redact") {
                yield { kind: "text_delta", delta: result.text };
                yield chunk;
                continue;
              }

              // "warn" — yield original buffer
              yield { kind: "text_delta", delta: buffer };
              yield chunk;
              continue;
            }

            // No secrets found — yield original buffer
            yield { kind: "text_delta", delta: buffer };
          }
        }

        yield chunk;
      }

      // If stream ended without a "done" chunk, flush buffered text
      if (!scanned && buffer.length > 0) {
        const result = redactor.redactString(buffer);
        if (result.matchCount > 0 && config.action === "redact") {
          yield { kind: "text_delta", delta: result.text };
        } else {
          yield { kind: "text_delta", delta: buffer };
        }
      }
    },
  };
}

/**
 * Extract redaction kinds by comparing original and redacted objects.
 * Looks for "[REDACTED:<kind>]" markers in the redacted output.
 */
function extractKindsFromRedaction(_original: unknown, redacted: unknown): readonly string[] {
  const kinds = new Set<string>();
  const text = JSON.stringify(redacted);
  const pattern = /\[REDACTED:([^\]]+)\]/g;

  // let justified: regex exec loop variable
  let m: RegExpExecArray | null = pattern.exec(text);
  while (m !== null) {
    const kind = m[1];
    if (kind !== undefined) {
      kinds.add(kind);
    }
    m = pattern.exec(text);
  }

  return [...kinds];
}
