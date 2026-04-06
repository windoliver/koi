/**
 * Exfiltration guard middleware — scans tool inputs and model output
 * for secret exfiltration attempts (base64/URL-encoded or raw secrets).
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
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

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const response = await next(request);

      if (!config.scanModelOutput) {
        return response;
      }

      // Build scannable text from content + richContent (tool_call args, thinking, etc.)
      const richText =
        response.richContent !== undefined ? safeSerializeForScan(response.richContent) : undefined;
      const textToScan =
        richText !== undefined ? `${response.content}\n${richText}` : response.content;

      if (textToScan.length === 0) {
        return response;
      }

      const result = redactor.redactString(textToScan);

      if (result.matchCount === -1) {
        fireDetection({
          location: "model-output",
          matchCount: 0,
          kinds: ["redaction_failure"],
          action: "block",
        });
        return sanitizeModelResponse(
          response,
          "[BLOCKED: exfiltration guard redaction engine failure]",
        );
      }

      if (result.matchCount > 0) {
        fireDetection({
          location: "model-output",
          matchCount: result.matchCount,
          kinds: [],
          action: config.action,
        });

        if (config.action === "block") {
          return sanitizeModelResponse(
            response,
            `[BLOCKED: ${String(result.matchCount)} secret(s) detected in model output]`,
          );
        }

        if (config.action === "redact") {
          // Redact content text and clear richContent (may contain tool_call args with secrets)
          const contentResult =
            response.content.length > 0
              ? redactor.redactString(response.content)
              : { text: response.content, matchCount: 0 };
          return { ...response, content: contentResult.text, richContent: undefined };
        }
        // "warn" — return unchanged
      }

      return response;
    },

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      // --- Input scanning (gated by scanToolInput) ---
      // let justified: mutable to allow redacting input before next()
      let effectiveRequest = request;
      if (config.scanToolInput) {
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
            effectiveRequest = { ...request, input: result.value };
          }
          // "warn" — continue with original request
        }
      }

      const response = await next(effectiveRequest);

      // --- Output scanning (always-on, independent of scanToolInput) ---
      // For non-serializable types (BigInt, cyclic), fall back to String(output)
      // so legitimate non-JSON tool results aren't hard-blocked.
      const outputToScan = safeSerializeForScan(response.output) ?? String(response.output);
      const outputResult = redactor.redactString(outputToScan);

      if (outputResult.matchCount > 0) {
        fireDetection({
          location: "tool-output",
          toolId: request.toolId,
          matchCount: outputResult.matchCount,
          kinds: [],
          action: config.action,
        });

        if (config.action === "block") {
          return {
            output: {
              error: `Exfiltration guard: ${String(outputResult.matchCount)} secret(s) detected in tool output — response blocked`,
              code: "PERMISSION",
            },
          };
        }

        if (config.action === "redact" && typeof response.output === "string") {
          return { ...response, output: outputResult.text };
        }
        // For redact on non-string outputs: block instead of attempting lossy JSON.parse
        if (config.action === "redact") {
          return {
            output: {
              error: `Exfiltration guard: ${String(outputResult.matchCount)} secret(s) detected in tool output — response blocked (cannot safely redact structured output)`,
              code: "PERMISSION",
            },
          };
        }
        // "warn" — return unchanged
      }

      return response;
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
      // let justified: tracks whether overflow triggered (buffer flushed, pass-through mode)
      let overflowed = false;

      // Buffered chunks — held for scanning, replayed on done
      const heldChunks: ModelChunk[] = [];

      for await (const chunk of next(request)) {
        // Buffer all content-bearing chunk kinds for scanning
        const isContentChunk =
          chunk.kind === "text_delta" ||
          chunk.kind === "thinking_delta" ||
          chunk.kind === "tool_call_delta" ||
          chunk.kind === "tool_call_start";

        if (isContentChunk) {
          // After overflow in redact mode: suppress remaining content (fail-closed).
          // After overflow in warn mode: yield raw (caller is aware scanning is degraded).
          if (overflowed) {
            if (config.action === "warn") {
              yield chunk;
            }
            continue;
          }

          heldChunks.push(chunk);
          // Extract scannable text from chunk
          const chunkText =
            "delta" in chunk && typeof chunk.delta === "string"
              ? chunk.delta
              : "args" in chunk && typeof chunk.args === "string"
                ? chunk.args
                : "";
          buffer += chunkText;

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
            // warn/redact: scan accumulated buffer, then degrade gracefully
            overflowed = true;
            fireDetection({
              location: "model-output",
              matchCount: 0,
              kinds: ["buffer_overflow"],
              action: config.action,
            });
            const overflowResult = redactor.redactString(buffer);
            if (overflowResult.matchCount > 0) {
              fireDetection({
                location: "model-output",
                matchCount: overflowResult.matchCount,
                kinds: [],
                action: config.action,
              });
            }
            if (config.action === "redact") {
              // Yield scanned buffer (redacted if secrets found) + truncation notice
              yield {
                kind: "text_delta",
                delta: overflowResult.matchCount > 0 ? overflowResult.text : buffer,
              };
              yield {
                kind: "text_delta",
                delta:
                  "\n[TRUNCATED: exfiltration guard scan buffer exceeded — remaining output suppressed]",
              };
            } else {
              // "warn" — replay original held chunks to preserve tool_call structure
              for (const held of heldChunks) {
                yield held;
              }
            }
            heldChunks.length = 0;
            buffer = "";
            continue;
          }

          // Buffer text deltas — don't yield yet, scan on done
          continue;
        }

        if (chunk.kind === "done" && !scanned && !overflowed) {
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
                // Emit only redacted text, suppress all held chunks (may contain secrets in tool_call/thinking)
                yield { kind: "text_delta", delta: result.text };
                // Sanitize done chunk: clear richContent which may retain secret-bearing tool_call args
                yield sanitizeDoneChunk(chunk);
                continue;
              }

              // "warn" — replay original held chunks
              for (const held of heldChunks) {
                yield held;
              }
              yield chunk;
              continue;
            }

            // No secrets found — replay all held chunks
            for (const held of heldChunks) {
              yield held;
            }
          }
        }

        // Sanitize done chunk when overflowed in redact mode to prevent
        // secret-bearing richContent from leaking through the terminal response
        if (overflowed && config.action === "redact" && chunk.kind === "done") {
          yield sanitizeDoneChunk(chunk);
        } else {
          yield chunk;
        }
      }

      // If stream ended without a "done" chunk, flush held chunks
      if (!scanned && !overflowed && heldChunks.length > 0) {
        const result = redactor.redactString(buffer);
        if (result.matchCount > 0 && config.action === "redact") {
          yield { kind: "text_delta", delta: result.text };
        } else {
          for (const held of heldChunks) {
            yield held;
          }
        }
      }
    },
  };
}

/**
 * Sanitize a blocked/failed ModelResponse: replace content, clear richContent
 * (which may contain tool_call args with secrets), and normalize stopReason
 * away from "tool_use" so downstream code cannot execute blocked tool calls.
 */
function sanitizeModelResponse(response: ModelResponse, content: string): ModelResponse {
  return {
    ...response,
    content,
    richContent: undefined,
    // Use "hook_blocked" so downstream treats this as a denied action, not a successful completion.
    // This ensures retries, observability, and turn logic all recognize the security block.
    stopReason: "hook_blocked",
  };
}

/**
 * Sanitize a streaming "done" chunk: clear richContent from the response to prevent
 * secret-bearing tool_call args or thinking blocks from leaking through the terminal chunk.
 */
function sanitizeDoneChunk(chunk: ModelChunk): ModelChunk {
  if (chunk.kind !== "done") return chunk;
  const resp = chunk.response;
  return {
    ...chunk,
    response: {
      ...resp,
      content: resp.content,
      richContent: undefined,
      stopReason: resp.stopReason === "tool_use" ? "hook_blocked" : resp.stopReason,
    },
  };
}

/**
 * Safely serialize a value for secret scanning. Returns the string representation
 * if the value is a string, primitive, or JSON-serializable object. Returns undefined
 * only for truly opaque types (BigInt, cyclic objects, Maps, etc.).
 *
 * Primitives (number, boolean, null) are converted to strings — they cannot contain
 * secrets but should not trigger fail-closed blocking either.
 */
function safeSerializeForScan(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return undefined;
  // Primitives: safe to stringify, cannot contain secrets
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object") return undefined; // BigInt, Symbol, function — opaque
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
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
