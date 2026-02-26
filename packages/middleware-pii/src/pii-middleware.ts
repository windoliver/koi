/**
 * PII middleware factory — detect and redact PII in agent I/O.
 *
 * Priority 340: runs after audit (300), before sanitize (350).
 * PII redacts first, then sanitize strips injection patterns.
 */

import type { JsonObject } from "@koi/core/common";
import type { InboundMessage } from "@koi/core/message";
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
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { validatePIIConfig } from "./config.js";
import { createAllDetectors } from "./detectors.js";
import { scanJson, scanMessage, scanString } from "./scan.js";
import type { PIIHasherFactory } from "./strategies.js";
import { createPIIStreamBuffer } from "./stream-buffer.js";
import type { PIIConfig, PIIDetector, PIIMatch, PIIStrategy } from "./types.js";

/**
 * Creates a PII middleware that detects and handles PII in model/tool I/O.
 * Requires `hashSecret` when strategy is `"hash"`.
 */
export function createPIIMiddleware(config: PIIConfig): KoiMiddleware {
  const validResult = validatePIIConfig(config);
  if (!validResult.ok) {
    throw KoiRuntimeError.from(validResult.error.code, validResult.error.message);
  }

  const validated = validResult.value;
  const strategy = validated.strategy;
  const scanInput = validated.scope?.input ?? true;
  const scanOutput = validated.scope?.output ?? false;
  const scanToolResults = validated.scope?.toolResults ?? false;
  const onDetection = validated.onDetection;

  // Merge built-in + custom detectors
  const builtIn = validated.detectors ?? createAllDetectors();
  const custom = validated.customDetectors ?? [];
  const detectors: readonly PIIDetector[] = [...builtIn, ...custom];

  // Build hasher factory if using hash strategy
  const createHasher: PIIHasherFactory | undefined =
    strategy === "hash" && validated.hashSecret !== undefined
      ? () => new Bun.CryptoHasher("sha256", validated.hashSecret!)
      : undefined;

  const capabilityFragment: CapabilityFragment = {
    label: "pii",
    description: "PII detection and redaction active",
  };

  return {
    name: "pii",
    priority: 340,

    describeCapabilities: (_ctx: TurnContext) => capabilityFragment,

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      // INPUT: scan request messages if input scope enabled
      const processedRequest = scanInput
        ? scanRequestMessages(request, detectors, strategy, createHasher, onDetection)
        : request;

      const response = await next(processedRequest);

      // OUTPUT: scan response content if output scope enabled
      if (!scanOutput) return response;

      const outputResult = scanString(response.content, detectors, strategy, createHasher);
      if (!outputResult.changed) return response;

      if (strategy === "block") {
        throw KoiRuntimeError.from("VALIDATION", "Model output contains PII", {
          context: { location: "output", matchCount: outputResult.matches.length },
        });
      }

      onDetection?.(outputResult.matches, "output");

      const metadata: JsonObject = {
        ...response.metadata,
        piiDetections: outputResult.matches.length,
      };
      return { ...response, content: outputResult.text, metadata };
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      // INPUT: scan request messages
      const processedRequest = scanInput
        ? scanRequestMessages(request, detectors, strategy, createHasher, onDetection)
        : request;

      if (!scanOutput) {
        yield* next(processedRequest);
        return;
      }

      // OUTPUT: buffer and scan streaming text
      const textBuf = createPIIStreamBuffer(detectors, strategy, createHasher);
      const thinkBuf = createPIIStreamBuffer(detectors, strategy, createHasher);

      for await (const chunk of next(processedRequest)) {
        switch (chunk.kind) {
          case "text_delta": {
            const result = textBuf.push(chunk.delta);
            if (result.safe.length > 0) {
              yield { kind: "text_delta", delta: result.safe };
            }
            if (result.matches.length > 0) {
              onDetection?.(result.matches, "output");
            }
            break;
          }
          case "thinking_delta": {
            const result = thinkBuf.push(chunk.delta);
            if (result.safe.length > 0) {
              yield { kind: "thinking_delta", delta: result.safe };
            }
            if (result.matches.length > 0) {
              onDetection?.(result.matches, "output");
            }
            break;
          }
          case "done": {
            const flushedText = textBuf.flush();
            if (flushedText.safe.length > 0) {
              yield { kind: "text_delta", delta: flushedText.safe };
            }
            if (flushedText.matches.length > 0) {
              onDetection?.(flushedText.matches, "output");
            }

            const flushedThink = thinkBuf.flush();
            if (flushedThink.safe.length > 0) {
              yield { kind: "thinking_delta", delta: flushedThink.safe };
            }
            if (flushedThink.matches.length > 0) {
              onDetection?.(flushedThink.matches, "output");
            }

            // Scan the final response content
            const finalResult = scanString(
              chunk.response.content,
              detectors,
              strategy === "block" ? "redact" : strategy,
              createHasher,
            );
            const finalResponse: ModelResponse = finalResult.changed
              ? { ...chunk.response, content: finalResult.text }
              : chunk.response;

            yield { kind: "done", response: finalResponse };
            break;
          }
          default:
            yield chunk;
        }
      }
    },

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const response = await next(request);

      if (!scanToolResults) return response;

      const outputResult = scanJson(response.output, detectors, strategy, createHasher);
      if (!outputResult.changed) return response;

      if (strategy === "block") {
        throw KoiRuntimeError.from("VALIDATION", `Tool "${request.toolId}" output contains PII`, {
          context: { toolId: request.toolId, location: "tool-output" },
        });
      }

      onDetection?.(outputResult.matches, "tool-output");
      return { ...response, output: outputResult.value };
    },
  };
}

/** Scan all messages in a ModelRequest for PII. Throws on block strategy. */
function scanRequestMessages(
  request: ModelRequest,
  detectors: readonly PIIDetector[],
  strategy: string,
  createHasher: PIIHasherFactory | undefined,
  onDetection: ((matches: readonly PIIMatch[], location: string) => void) | undefined,
): ModelRequest {
  // let justified: tracks whether any message was modified
  let anyChanged = false;

  const scannedMessages = request.messages.map((msg: InboundMessage) => {
    const result = scanMessage(msg, detectors, strategy as PIIStrategy, createHasher);

    if (result.changed) {
      anyChanged = true;

      if (strategy === "block") {
        throw KoiRuntimeError.from("VALIDATION", "Input message contains PII", {
          context: { location: "input", matchCount: result.matches.length },
        });
      }

      onDetection?.(result.matches, "input");
    }

    return result.message;
  });

  if (!anyChanged) return request;
  return { ...request, messages: scannedMessages };
}
