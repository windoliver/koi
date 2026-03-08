/**
 * OpenAI provider adapter.
 *
 * Normalizes OpenAI chat completion API to the ProviderAdapter interface.
 * Uses raw fetch — no SDK dependency.
 */

import type { ContentBlock, ModelRequest, ModelResponse } from "@koi/core";
import type { NormalizedRole } from "../normalize.js";
import { normalizeMessages, normalizeToPlainText } from "../normalize.js";
import type { ProviderAdapter, ProviderAdapterConfig } from "../provider-adapter.js";
import { createOpenAICompatibleAdapter } from "./openai-compat.js";

// Re-export shared mapStatusToErrorCode for backward compatibility
export { mapStatusToErrorCode } from "./shared.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// OpenAI structured content types
// ---------------------------------------------------------------------------

interface OpenAITextPart {
  readonly type: "text";
  readonly text: string;
}

interface OpenAIImageUrlPart {
  readonly type: "image_url";
  readonly image_url: { readonly url: string };
}

type OpenAIContentPart = OpenAITextPart | OpenAIImageUrlPart;

interface OpenAIChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | readonly OpenAIContentPart[];
}

interface OpenAIChatRequest {
  readonly model: string;
  readonly messages: readonly OpenAIChatMessage[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly stream?: boolean;
}

interface OpenAIUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

interface OpenAIChatResponse {
  readonly id: string;
  readonly model: string;
  readonly choices: readonly {
    readonly message: {
      readonly role: string;
      readonly content: string | null;
    };
    readonly finish_reason: string;
  }[];
  readonly usage?: OpenAIUsage;
}

// ---------------------------------------------------------------------------
// Content block conversion
// ---------------------------------------------------------------------------

/**
 * Converts a single Koi ContentBlock to an OpenAI content part.
 * Text and image blocks map natively; unsupported types fall back to text.
 */
function contentBlockToOpenAIPart(block: ContentBlock): OpenAIContentPart {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image_url", image_url: { url: block.url } };
    default:
      // file, button, custom → fall back to plain text representation
      return { type: "text", text: normalizeToPlainText([block]) };
  }
}

/**
 * Converts Koi ContentBlock[] to OpenAI message content.
 * Returns a plain string when all blocks are text (simpler API payload);
 * returns a structured array when images are present.
 */
function contentBlocksToOpenAI(
  content: readonly ContentBlock[],
): string | readonly OpenAIContentPart[] {
  const hasNonText = content.some((b) => b.kind === "image");
  if (!hasNonText) {
    return normalizeToPlainText(content);
  }
  return content.map(contentBlockToOpenAIPart);
}

/**
 * Maps a NormalizedRole to an OpenAI chat role.
 */
function mapRoleToOpenAI(role: NormalizedRole): "system" | "user" | "assistant" {
  return role;
}

/**
 * Transforms a Koi ModelRequest into an OpenAI chat completion request.
 * Preserves original message roles and rich content (images).
 */
export function toOpenAIRequest(request: ModelRequest): OpenAIChatRequest {
  const normalized = normalizeMessages(request.messages);
  const messages: readonly OpenAIChatMessage[] = normalized.map((m) => ({
    role: mapRoleToOpenAI(m.role),
    content: contentBlocksToOpenAI(m.content),
  }));

  return {
    model: request.model ?? "gpt-4o",
    messages,
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
  };
}

/**
 * Transforms an OpenAI chat completion response into a Koi ModelResponse.
 */
export function fromOpenAIResponse(response: OpenAIChatResponse): ModelResponse {
  const content = response.choices[0]?.message.content ?? "";

  return {
    content,
    model: response.model,
    ...(response.usage && {
      usage: {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      },
    }),
  };
}

/**
 * Creates an OpenAI provider adapter.
 *
 * Delegates to the shared OpenAI-compatible base adapter with OpenAI-specific defaults.
 */
export function createOpenAIAdapter(config: ProviderAdapterConfig): ProviderAdapter {
  const compat = createOpenAICompatibleAdapter({
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    apiKey: config.apiKey,
    headers: config.headers,
    providerName: "OpenAI",
    defaultModel: "gpt-4o",
  });

  return {
    id: "openai",
    complete: compat.complete,
    stream: compat.stream,
  };
}
