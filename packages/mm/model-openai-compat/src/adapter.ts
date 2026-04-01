/**
 * OpenAI-compatible model adapter with production resilience.
 *
 * Features from Claude Code's production implementation:
 * - Stream idle watchdog (90s timeout, resets per chunk, cancels body read)
 * - Retry with exponential backoff + jitter (pre-stream errors only)
 * - ECONNRESET detection → disable keep-alive for fresh TCP
 * - 529 overloaded: retryable error (caller decides foreground/background policy)
 */

import type { ModelAdapter, ModelChunk, ModelRequest, ModelResponse } from "@koi/core";
import { mapProviderError } from "./error-mapper.js";
import { buildRequestBody } from "./request-mapper.js";
import { buildModelResponse, createEmptyAccumulator } from "./response-mapper.js";
import type { RetryConfig } from "./retry.js";
import {
  computeRetryDelay,
  DEFAULT_RETRY_CONFIG,
  isConnectionResetError,
  isConnectionResetMessage,
  isRetryableStatus,
  sleepWithSignal,
} from "./retry.js";
import { createStreamParser, parseSSELines } from "./stream-parser.js";
import { mapToolDescriptors } from "./tool-mapper.js";
import type { OpenAICompatAdapterConfig, ResolvedConfig } from "./types.js";
import { resolveConfig } from "./types.js";

/** Stream idle timeout — abort hung streams after 90s of no data. */
const STREAM_IDLE_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOpenAICompatAdapter(config: OpenAICompatAdapterConfig): ModelAdapter {
  const resolved = resolveConfig(config);

  // Resolve retry config from user overrides
  const retryConfig: RetryConfig = {
    maxRetries: config.retry?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
    baseDelayMs: config.retry?.baseDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs,
    maxDelayMs: config.retry?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs,
    jitterFactor: DEFAULT_RETRY_CONFIG.jitterFactor,
  };

  // Track whether keep-alive should be disabled (ECONNRESET recovery)
  let disableKeepAlive = false;

  // Lazy TLS pre-warm — fires on first stream()/complete() call, not at
  // construction. Avoids leaking credentials to a misconfigured baseUrl
  // during dry runs or test setup where no real request is intended.
  let prewarmed = false;
  function lazyPrewarm(): void {
    if (prewarmed) return;
    prewarmed = true;
    void fetch(`${resolved.baseUrl}/models`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${resolved.apiKey}` },
    }).catch(() => {});
  }

  const adapter: ModelAdapter = {
    id: `${resolved.provider}:${resolved.model}`,
    provider: resolved.provider,
    capabilities: resolved.capabilities,
    complete: (request) => {
      lazyPrewarm();
      return complete(resolved, request, retryConfig, () => disableKeepAlive);
    },
    stream: (request) => {
      lazyPrewarm();
      return streamWithRetry(
        resolved,
        request,
        retryConfig,
        () => disableKeepAlive,
        (v) => {
          disableKeepAlive = v;
        },
      );
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Non-streaming: accumulate stream into ModelResponse
// ---------------------------------------------------------------------------

async function complete(
  config: ResolvedConfig,
  request: ModelRequest,
  retryConfig: RetryConfig,
  getDisableKeepAlive: () => boolean,
): Promise<ModelResponse> {
  let lastResponse: ModelResponse | undefined;

  for await (const chunk of streamWithRetry(
    config,
    request,
    retryConfig,
    getDisableKeepAlive,
    () => {},
  )) {
    if (chunk.kind === "done") {
      lastResponse = chunk.response;
    }
    if (chunk.kind === "error") {
      throw new Error(chunk.message, {
        cause: { code: chunk.code, retryable: chunk.retryable, retryAfterMs: chunk.retryAfterMs },
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
// Streaming with retry wrapper
// ---------------------------------------------------------------------------

/**
 * Retry wrapper that only retries PRE-STREAM errors (HTTP errors, connection
 * failures). Once any content chunk has been yielded to the consumer, the
 * attempt is committed — no retry, because the consumer already has partial
 * data and replaying would duplicate text/tool events.
 */
async function* streamWithRetry(
  config: ResolvedConfig,
  request: ModelRequest,
  retryConfig: RetryConfig,
  getDisableKeepAlive: () => boolean,
  setDisableKeepAlive: (v: boolean) => void,
): AsyncIterable<ModelChunk> {
  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    let shouldRetry = false;
    let retryAfterMs: number | undefined;
    let hasYieldedContent = false;

    for await (const chunk of streamOnce(config, request, getDisableKeepAlive)) {
      if (chunk.kind === "error") {
        // ECONNRESET → disable keep-alive for subsequent requests
        if (isConnectionResetMessage(chunk.message)) {
          setDisableKeepAlive(true);
        }

        // Only retry if NO content has been yielded yet. Once text_delta,
        // tool_call_start, or thinking_delta has escaped to the consumer,
        // retrying would replay those events and corrupt the output.
        if (!hasYieldedContent && chunk.retryable === true && attempt < retryConfig.maxRetries) {
          shouldRetry = true;
          retryAfterMs = chunk.retryAfterMs;
          break; // Exit inner loop, retry
        }
      }

      // Track whether consumer-visible content has been emitted
      if (
        chunk.kind === "text_delta" ||
        chunk.kind === "thinking_delta" ||
        chunk.kind === "tool_call_start" ||
        chunk.kind === "tool_call_delta" ||
        chunk.kind === "tool_call_end"
      ) {
        hasYieldedContent = true;
      }

      yield chunk;
    }

    if (!shouldRetry) return;

    // Wait before retry
    const delay = computeRetryDelay(attempt, retryConfig, retryAfterMs);
    const continued = await sleepWithSignal(delay, request.signal);
    if (!continued) return; // Aborted during backoff
  }
}

// ---------------------------------------------------------------------------
// Single stream attempt (no retry)
// ---------------------------------------------------------------------------

async function* streamOnce(
  config: ResolvedConfig,
  request: ModelRequest,
  getDisableKeepAlive: () => boolean,
): AsyncIterable<ModelChunk> {
  const tools =
    request.tools !== undefined ? mapToolDescriptors(request.tools, config.compat) : undefined;
  const body = buildRequestBody(request, config, tools);
  const url = `${config.baseUrl}/chat/completions`;

  // Stream idle watchdog — create BEFORE fetch so the signal can cancel
  // both the HTTP request and the body stream reader.
  const idleController = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function resetIdleTimer(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleController.abort("stream_idle_timeout");
    }, STREAM_IDLE_TIMEOUT_MS);
  }

  function clearIdleTimer(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  // Combine user signal with idle watchdog — this signal is passed to fetch()
  // so that both the initial request AND the body stream read are cancelled
  // when either the user aborts or the idle timer fires.
  const combinedSignal = request.signal
    ? AbortSignal.any([request.signal, idleController.signal])
    : idleController.signal;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    Connection: getDisableKeepAlive() ? "close" : "keep-alive",
    ...config.headers,
  };

  // Start idle timer — covers the fetch() phase too
  resetIdleTimer();

  // --- Fetch with combined signal (user abort + idle watchdog) ---
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (error: unknown) {
    clearIdleTimer();
    if (request.signal?.aborted === true) return; // User abort — clean

    // Idle timeout during fetch
    if (idleController.signal.aborted) {
      yield {
        kind: "error",
        message: `Stream idle for ${STREAM_IDLE_TIMEOUT_MS / 1000}s — aborting hung connection`,
        code: "TIMEOUT",
        retryable: true,
      };
      return;
    }

    const isConnReset = isConnectionResetError(error);
    yield {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
      code: "EXTERNAL",
      retryable: isConnReset,
    };
    return;
  }

  // --- HTTP errors ---
  if (!response.ok) {
    clearIdleTimer();
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
      retryable: isRetryableStatus(response.status),
      retryAfterMs: koiError.retryAfterMs,
    };
    return;
  }

  // --- Parse SSE stream ---
  const responseBody = response.body;
  if (responseBody === null) {
    clearIdleTimer();
    yield {
      kind: "error",
      message: `${config.provider} returned 200 OK with no response body`,
      code: "EXTERNAL",
      retryable: true,
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

  // Reset idle timer — headers arrived, now timing body chunks
  resetIdleTimer();

  try {
    // The combinedSignal was passed to fetch(), so when the idle timer fires
    // and aborts idleController, the body stream read throws an AbortError.
    // This is what makes the watchdog actually cancel hung reads.
    for await (const rawChunk of responseBody) {
      resetIdleTimer();

      const text = decoder.decode(rawChunk as Uint8Array, { stream: true });
      if (text.includes("[DONE]")) sawDone = true;
      buffer += text;

      const parts = buffer.split("\n\n");
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

    clearIdleTimer();

    // Process remaining buffer
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

    if (hadError) return;

    const acc = parser.getAccumulator();
    if (!acc.receivedFinishReason) {
      yield {
        kind: "error",
        message: sawDone
          ? "Stream sent [DONE] without a finish_reason — possible truncation"
          : "Stream terminated without [DONE] marker or finish_reason — possible truncation",
        code: "EXTERNAL",
        retryable: true,
      };
      return;
    }

    for (const chunk of parser.finish()) {
      if (chunk.kind === "error") {
        yield chunk;
        return;
      }
      yield chunk;
    }

    yield { kind: "done", response: buildModelResponse(acc) };
  } catch (error: unknown) {
    clearIdleTimer();
    if (request.signal?.aborted === true) return;

    // Idle timeout fired → aborted the body read → threw AbortError
    if (idleController.signal.aborted) {
      yield {
        kind: "error",
        message: `Stream idle for ${STREAM_IDLE_TIMEOUT_MS / 1000}s — aborting hung connection`,
        code: "TIMEOUT",
        retryable: true,
      };
      return;
    }

    const isConnReset = isConnectionResetError(error);
    yield {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
      code: "EXTERNAL",
      retryable: isConnReset,
    };
  }
}
