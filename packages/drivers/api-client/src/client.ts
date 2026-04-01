/**
 * Factory for creating Anthropic SDK-backed ModelHandler and ModelStreamHandler.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ModelChunk, ModelHandler, ModelRequest, ModelStreamHandler } from "@koi/core";
import { DEFAULT_RETRY_CONFIG, type RetryConfig, withRetry } from "@koi/errors";
import type { AnthropicClientConfig } from "./config.js";
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from "./config.js";
import { mapAnthropicError } from "./map-error.js";
import { toAnthropicParams, toAnthropicStreamParams } from "./map-request.js";
import { fromAnthropicMessage } from "./map-response.js";
import { mapAnthropicStream } from "./map-stream.js";

/** Return type of the factory — a pair of L0-compatible handlers. */
export interface AnthropicClient {
  readonly complete: ModelHandler;
  readonly stream: ModelStreamHandler;
}

/**
 * Create the underlying SDK client based on provider config.
 *
 * Bedrock and Vertex require separate SDK packages (@anthropic-ai/bedrock-sdk,
 * @anthropic-ai/vertex-sdk) and are loaded dynamically to keep them optional.
 */
async function createSdkClient(config: AnthropicClientConfig): Promise<Anthropic> {
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  switch (config.provider ?? "direct") {
    case "bedrock": {
      // @ts-expect-error — optional peer dependency, not installed by default
      const { default: AnthropicBedrock } = await import("@anthropic-ai/bedrock-sdk");
      return new AnthropicBedrock({
        awsRegion: config.awsRegion,
        awsAccessKey: config.awsAccessKey,
        awsSecretKey: config.awsSecretKey,
        awsSessionToken: config.awsSessionToken,
        timeout,
      }) as unknown as Anthropic;
    }
    case "vertex": {
      // @ts-expect-error — optional peer dependency, not installed by default
      const { default: AnthropicVertex } = await import("@anthropic-ai/vertex-sdk");
      return new AnthropicVertex({
        projectId: config.googleProjectId,
        region: config.googleRegion,
        timeout,
      }) as unknown as Anthropic;
    }
    default:
      return new Anthropic({
        apiKey: config.apiKey,
        ...(config.baseUrl !== undefined ? { baseURL: config.baseUrl } : {}),
        timeout,
      });
  }
}

/**
 * Create an Anthropic SDK-backed client providing ModelHandler and ModelStreamHandler.
 *
 * The `complete` handler wraps `messages.create()` with retry logic.
 * The `stream` handler wraps `messages.stream()` and yields ModelChunk values.
 *
 * Async because Bedrock/Vertex providers require dynamic imports.
 */
export async function createAnthropicClient(
  config: AnthropicClientConfig = {},
): Promise<AnthropicClient> {
  const sdk = await createSdkClient(config);
  const model = config.model ?? DEFAULT_MODEL;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const retryConfig: RetryConfig = config.retryConfig ?? DEFAULT_RETRY_CONFIG;
  const defaults = { model, maxTokens };

  const complete: ModelHandler = async (request: ModelRequest) => {
    const params = toAnthropicParams(request, defaults);

    const executeCall = async (): Promise<Anthropic.Message> => {
      try {
        return await sdk.messages.create(params, {
          signal: request.signal ?? undefined,
        });
      } catch (error: unknown) {
        throw mapAnthropicError(error);
      }
    };

    try {
      const message = await withRetry(executeCall, retryConfig);
      return fromAnthropicMessage(message);
    } catch (error: unknown) {
      // Fallback model: one attempt with alternate model
      if (config.fallbackModel !== undefined) {
        const fallbackParams = { ...params, model: config.fallbackModel };
        try {
          const message = await sdk.messages.create(fallbackParams, {
            signal: request.signal ?? undefined,
          });
          return fromAnthropicMessage(message);
        } catch (fallbackError: unknown) {
          throw mapAnthropicError(fallbackError);
        }
      }
      throw error;
    }
  };

  const stream: ModelStreamHandler = (request: ModelRequest): AsyncIterable<ModelChunk> => {
    const streamParams = toAnthropicStreamParams(request, defaults);

    async function* generate(): AsyncIterable<ModelChunk> {
      try {
        const sdkStream = sdk.messages.stream(streamParams, {
          signal: request.signal ?? undefined,
        });

        yield* mapAnthropicStream(sdkStream, model);
      } catch (error: unknown) {
        const mapped = mapAnthropicError(error);
        yield { kind: "error", message: mapped.message };
      }
    }

    return generate();
  };

  return { complete, stream };
}
