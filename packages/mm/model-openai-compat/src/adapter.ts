/**
 * OpenRouter model adapter — implements ModelAdapter for OpenAI Chat Completions API.
 */

import type { ModelAdapter, ModelChunk, ModelRequest, ModelResponse } from "@koi/core";
import { mapProviderError } from "./error-mapper.js";
import { buildRequestBody } from "./request-mapper.js";
import { buildModelResponse, createEmptyAccumulator } from "./response-mapper.js";
import { createStreamParser, parseSSELines } from "./stream-parser.js";
import { mapToolDescriptors } from "./tool-mapper.js";
import type { OpenAICompatAdapterConfig, ResolvedConfig } from "./types.js";
import { resolveConfig } from "./types.js";

/**
 * Create a provider-agnostic model adapter for OpenRouter and any
 * OpenAI Chat Completions-compatible API.
 *
 * The adapter uses `async function*` for streaming with natural backpressure.
 * All request preparation happens before `fetch()` — zero blocking in the
 * streaming path.
 */
export function createOpenAICompatAdapter(config: OpenAICompatAdapterConfig): ModelAdapter {
  const resolved = resolveConfig(config);

  // Pre-warm TLS connection in the background to eliminate cold-start latency
  // on the first stream()/complete() call (~300ms saving on cold connections).
  // The fetch is fire-and-forget; failures are silently ignored.
  void fetch(`${resolved.baseUrl}/models`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${resolved.apiKey}` },
  }).catch(() => {});

  const adapter: ModelAdapter = {
    id: `${resolved.provider}:${resolved.model}`,
    provider: resolved.provider,
    capabilities: resolved.capabilities,
    complete: (request) => complete(resolved, request),
    stream: (request) => stream(resolved, request),
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Non-streaming: accumulate stream into ModelResponse
// ---------------------------------------------------------------------------

async function complete(config: ResolvedConfig, request: ModelRequest): Promise<ModelResponse> {
  let lastResponse: ModelResponse | undefined;

  for await (const chunk of stream(config, request)) {
    if (chunk.kind === "done") {
      lastResponse = chunk.response;
    }
    if (chunk.kind === "error") {
      throw new Error(chunk.message, {
        cause: {
          code: chunk.code,
          retryable: chunk.retryable,
          retryAfterMs: chunk.retryAfterMs,
        },
      });
    }
  }

  if (lastResponse === undefined) {
    if (request.signal?.aborted === true) {
      throw new Error("Request was aborted", { cause: { code: "EXTERNAL" } });
    }
    return { content: "", model: config.model };
  }

  return lastResponse;
}

// ---------------------------------------------------------------------------
// Streaming: async generator yielding ModelChunk
// ---------------------------------------------------------------------------

async function* stream(config: ResolvedConfig, request: ModelRequest): AsyncIterable<ModelChunk> {
  // --- All prep before fetch() (Issue #15: first-chunk latency) ---
  const tools =
    request.tools !== undefined ? mapToolDescriptors(request.tools, config.compat) : undefined;
  const body = buildRequestBody(request, config, tools);
  const url = `${config.baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    Connection: "keep-alive",
    ...config.headers,
  };

  // --- Fetch with abort signal propagation ---
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal ?? null,
    });
  } catch (error: unknown) {
    const isAbort = request.signal?.aborted === true;
    if (isAbort) return; // Clean abort — no error chunk
    yield {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
      code: "EXTERNAL",
    };
    return;
  }

  // --- Handle HTTP errors ---
  if (!response.ok) {
    const errorBody = await response.text();
    const koiError = mapProviderError(
      response.status,
      errorBody,
      response.headers,
      `${config.provider} API error (${response.status})`,
    );
    yield {
      kind: "error",
      message: koiError.message,
      code: koiError.code,
      retryable: koiError.retryable,
      retryAfterMs: koiError.retryAfterMs,
    };
    return;
  }

  // --- Parse SSE stream ---
  const responseBody = response.body;
  if (responseBody === null) {
    yield {
      kind: "error",
      message: `${config.provider} returned 200 OK with no response body`,
      code: "EXTERNAL",
    };
    return;
  }

  const effectiveModel = request.model ?? config.model;
  const accumulator = createEmptyAccumulator(effectiveModel);
  const parser = createStreamParser(accumulator);
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  let hadError = false;

  try {
    for await (const rawChunk of responseBody) {
      // Check abort between chunks (edge case #5)
      if (request.signal?.aborted === true) return;

      const text = decoder.decode(rawChunk as Uint8Array, { stream: true });
      if (text.includes("[DONE]")) sawDone = true;
      buffer += text;

      // Process complete SSE events (split on double newline)
      const parts = buffer.split("\n\n");
      // Keep the last incomplete part in the buffer
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        for (const sseResult of parseSSELines(`${part}\n`)) {
          if (!sseResult.ok) {
            yield {
              kind: "error",
              message: `Malformed SSE payload: ${sseResult.raw}`,
              code: "EXTERNAL",
            };
            hadError = true;
            continue;
          }
          for (const chunk of parser.feed(sseResult.chunk)) {
            if (chunk.kind === "error") hadError = true;
            yield chunk;
          }
        }
      }
    }

    // Process any remaining buffered data
    if (buffer.trim().length > 0) {
      if (buffer.includes("[DONE]")) sawDone = true;
      for (const sseResult of parseSSELines(`${buffer}\n`)) {
        if (!sseResult.ok) {
          yield {
            kind: "error",
            message: `Malformed SSE payload: ${sseResult.raw}`,
            code: "EXTERNAL",
          };
          hadError = true;
          continue;
        }
        for (const chunk of parser.feed(sseResult.chunk)) {
          if (chunk.kind === "error") hadError = true;
          yield chunk;
        }
      }
    }

    // If any error was emitted during streaming, do not finalize
    if (hadError) return;

    // Verify stream integrity BEFORE finalizing tool calls.
    // This prevents emitting tool_call_end events from a truncated stream
    // that consumers might act on before the error arrives.
    const acc = parser.getAccumulator();
    if (!acc.receivedFinishReason) {
      yield {
        kind: "error",
        message: sawDone
          ? "Stream sent [DONE] without a finish_reason — possible truncation"
          : "Stream terminated without [DONE] marker or finish_reason — possible truncation",
        code: "EXTERNAL",
      };
      return;
    }

    // Stream verified — safe to finalize and emit tool_call_end events
    for (const chunk of parser.finish()) {
      if (chunk.kind === "error") {
        yield chunk;
        return; // Malformed tool args — stop, don't emit done
      }
      yield chunk;
    }

    yield { kind: "done", response: buildModelResponse(acc) };
  } catch (error: unknown) {
    if (request.signal?.aborted === true) return;
    yield {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
      code: "EXTERNAL",
    };
  }
}
