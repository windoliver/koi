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
      ctx: TurnContext,
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
        ctx.reportDecision?.({
          location: "model-output",
          matchCount: 0,
          action: "block",
          error: "redaction_failure",
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
        ctx.reportDecision?.({
          location: "model-output",
          matchCount: result.matchCount,
          action: config.action,
          scanLength: textToScan.length,
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
      ctx: TurnContext,
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
          ctx.reportDecision?.({
            location: "tool-input",
            toolId: request.toolId,
            matchCount: result.secretCount,
            action: config.action,
            ...(kinds.length > 0 ? { kinds } : {}),
            scanLength: JSON.stringify(request.input).length,
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
      // Scan both JSON serialization AND String() representation to catch secrets
      // hidden by toJSON() or non-enumerable properties (e.g., Error.message).
      const jsonScan = safeSerializeForScan(response.output);
      const stringScan =
        response.output !== null && response.output !== undefined
          ? String(response.output)
          : undefined;
      const outputToScan =
        jsonScan !== undefined && stringScan !== undefined && stringScan !== jsonScan
          ? `${jsonScan}\n${stringScan}`
          : (jsonScan ?? stringScan ?? "");
      const outputResult = redactor.redactString(outputToScan);

      // Fail-closed: redaction engine failure on tool output
      if (outputResult.matchCount === -1) {
        fireDetection({
          location: "tool-output",
          toolId: request.toolId,
          matchCount: 0,
          kinds: ["redaction_failure"],
          action: "block",
        });
        ctx.reportDecision?.({
          location: "tool-output",
          toolId: request.toolId,
          matchCount: 0,
          action: "block",
          error: "redaction_failure",
        });
        return {
          output: {
            error:
              "Exfiltration guard: redaction engine failure on tool output — blocked (fail-closed)",
            code: "INTERNAL",
          },
        };
      }

      if (outputResult.matchCount > 0) {
        fireDetection({
          location: "tool-output",
          toolId: request.toolId,
          matchCount: outputResult.matchCount,
          kinds: [],
          action: config.action,
        });
        ctx.reportDecision?.({
          location: "tool-output",
          toolId: request.toolId,
          matchCount: outputResult.matchCount,
          action: config.action,
          scanLength: outputToScan.length,
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
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      if (!config.scanModelOutput) {
        yield* next(request);
        return;
      }

      // let justified: accumulates ALL content for scanning (text + thinking + tool args)
      let buffer = "";
      // let justified: accumulates ONLY user-visible text_delta content for redacted output
      let textOnlyBuffer = "";
      // let justified: tracks whether we've already scanned and acted
      let scanned = false;
      // let justified: tracks whether overflow triggered (buffer flushed, pass-through mode)
      let overflowed = false;

      // Buffered chunks — held for scanning, replayed on done
      const heldChunks: ModelChunk[] = [];

      for await (const chunk of next(request)) {
        // Buffer all content-bearing and tool-call lifecycle chunk kinds for scanning.
        // tool_call_end MUST be buffered alongside start/delta to preserve ordering.
        const isContentChunk =
          chunk.kind === "text_delta" ||
          chunk.kind === "thinking_delta" ||
          chunk.kind === "tool_call_delta" ||
          chunk.kind === "tool_call_start" ||
          chunk.kind === "tool_call_end";

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
          // Track user-visible text separately for redacted output
          if (chunk.kind === "text_delta" && "delta" in chunk) {
            textOnlyBuffer += chunk.delta;
          }

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
              // Only emit user-visible text (redacted). Never emit the full buffer as
              // text_delta — it contains thinking/tool_call content that must stay hidden.
              if (textOnlyBuffer.length > 0) {
                const textOverflowResult = redactor.redactString(textOnlyBuffer);
                yield { kind: "text_delta", delta: textOverflowResult.text };
              }
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
              ctx.reportDecision?.({
                location: "model-output-stream",
                matchCount: 0,
                action: "block",
                error: "redaction_failure",
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
              ctx.reportDecision?.({
                location: "model-output-stream",
                matchCount: result.matchCount,
                action: config.action,
                bufferLength: buffer.length,
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
                // Only emit user-visible text (redacted). Thinking/tool_call chunks are
                // suppressed entirely to avoid leaking hidden content as visible text.
                const redactedText =
                  textOnlyBuffer.length > 0 ? redactor.redactString(textOnlyBuffer).text : "";
                if (redactedText.length > 0) {
                  yield { kind: "text_delta", delta: redactedText };
                }
                // Sanitize done chunk: clear content + richContent to prevent bypasses
                yield sanitizeDoneChunk(chunk, redactedText);
                continue;
              }

              // "warn" — replay original held chunks
              for (const held of heldChunks) {
                yield held;
              }
              yield chunk;
              continue;
            }

            // Buffer scan found no secrets — also check done.response payload
            // in case the adapter placed final content only in the terminal chunk.
            const donePayload = buildDonePayloadForScan(chunk);
            if (donePayload !== undefined) {
              const doneResult = redactor.redactString(donePayload);
              if (doneResult.matchCount > 0) {
                fireDetection({
                  location: "model-output",
                  matchCount: doneResult.matchCount,
                  kinds: [],
                  action: config.action,
                });
                if (config.action === "block") {
                  yield {
                    kind: "error",
                    message: `Exfiltration guard: ${String(doneResult.matchCount)} secret(s) detected in terminal model response — blocked`,
                    code: "PERMISSION",
                    retryable: false,
                  };
                  return;
                }
                if (config.action === "redact") {
                  if (textOnlyBuffer.length > 0) {
                    yield { kind: "text_delta", delta: textOnlyBuffer };
                  }
                  yield sanitizeDoneChunk(chunk);
                  continue;
                }
                // "warn" — fall through to replay
              }
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

      // If stream ended without a "done" chunk, flush held chunks.
      // Apply same block/redact/warn semantics as the normal done path.
      if (!scanned && !overflowed && heldChunks.length > 0) {
        const result = redactor.redactString(buffer);
        if (result.matchCount > 0 || result.matchCount === -1) {
          fireDetection({
            location: "model-output",
            matchCount: Math.max(0, result.matchCount),
            kinds: result.matchCount === -1 ? ["redaction_failure"] : [],
            action: config.action,
          });
          if (config.action === "block") {
            yield {
              kind: "error",
              message: `Exfiltration guard: ${result.matchCount === -1 ? "redaction failure" : `${String(result.matchCount)} secret(s) detected`} in truncated model output — blocked`,
              code: result.matchCount === -1 ? "INTERNAL" : "PERMISSION",
              retryable: false,
            };
            return;
          }
          if (config.action === "redact") {
            if (textOnlyBuffer.length > 0) {
              const textRedacted = redactor.redactString(textOnlyBuffer);
              yield { kind: "text_delta", delta: textRedacted.text };
            }
            return;
          }
          // "warn" — fall through to replay
        }
        // No secrets or warn mode — replay all held chunks
        for (const held of heldChunks) {
          yield held;
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
 * Build a scannable string from a done chunk's response payload (content + richContent).
 * Returns undefined if there's nothing to scan.
 */
function buildDonePayloadForScan(chunk: ModelChunk): string | undefined {
  if (chunk.kind !== "done") return undefined;
  const resp = chunk.response;
  const parts: string[] = [];
  if (resp.content.length > 0) parts.push(resp.content);
  if (resp.richContent !== undefined) {
    const rich = safeSerializeForScan(resp.richContent);
    if (rich !== undefined) parts.push(rich);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Sanitize a streaming "done" chunk: clear richContent AND content from the response
 * to prevent secret-bearing data from leaking through the terminal chunk.
 * Downstream consumers prefer done.response.content over accumulated deltas,
 * so leaving content intact would bypass the redaction.
 *
 * @param replacementContent - sanitized text to use as response.content (default: empty)
 */
function sanitizeDoneChunk(chunk: ModelChunk, replacementContent = ""): ModelChunk {
  if (chunk.kind !== "done") return chunk;
  const resp = chunk.response;
  return {
    ...chunk,
    response: {
      ...resp,
      content: replacementContent,
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
    // JSON.stringify failed (cyclic, BigInt in nested field, etc.)
    // Recursively walk object properties to extract scannable string values.
    // Cycle-safe via WeakSet, depth-bounded to prevent unbounded scan time.
    return deepExtractStrings(value);
  }
}

/** Max depth for recursive string extraction to bound scan time. */
const EXTRACT_MAX_DEPTH = 5;

/**
 * Recursively extract string and string-coercible values from an object's
 * enumerable properties. Uses a visited set for cycle safety and a depth
 * limit to bound scan time. Returns concatenated string for scanning,
 * or undefined if no scannable content is found.
 */
function deepExtractStrings(
  value: unknown,
  visited: WeakSet<object> = new WeakSet(),
  depth = 0,
): string | undefined {
  if (depth > EXTRACT_MAX_DEPTH) return undefined;
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object") return undefined;

  const obj = value as Record<string, unknown>;
  if (visited.has(obj)) return undefined; // cycle detected
  visited.add(obj);

  // Handle Map: extract values
  if (value instanceof Map) {
    const parts: string[] = [];
    for (const v of (value as Map<unknown, unknown>).values()) {
      const extracted = deepExtractStrings(v, visited, depth + 1);
      if (extracted !== undefined) parts.push(extracted);
    }
    return parts.length > 0 ? parts.join(" ") : undefined;
  }

  // Handle arrays and plain objects
  const parts: string[] = [];
  const keys = Array.isArray(obj) ? obj.map((_, i) => String(i)) : Object.keys(obj);
  for (const key of keys) {
    const extracted = deepExtractStrings(obj[key], visited, depth + 1);
    if (extracted !== undefined) parts.push(extracted);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
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
