/**
 * Assemble Anthropic SDK MessageCreateParams from a Koi ModelRequest.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { ModelRequest } from "@koi/core";
import { toAnthropicTools } from "./map-tools.js";
import { extractSystemAndMessages } from "./normalize.js";

/** Defaults applied when ModelRequest fields are omitted. */
export interface RequestDefaults {
  readonly model: string;
  readonly maxTokens: number;
}

/** Convert a Koi ModelRequest to Anthropic SDK message create params. */
export function toAnthropicParams(
  request: ModelRequest,
  defaults: RequestDefaults,
): Anthropic.MessageCreateParamsNonStreaming {
  const { system, messages } = extractSystemAndMessages(request.messages);

  return {
    model: request.model ?? defaults.model,
    messages: messages as Anthropic.MessageParam[],
    max_tokens: request.maxTokens ?? defaults.maxTokens,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(system !== undefined ? { system } : {}),
    ...(request.tools !== undefined && request.tools.length > 0
      ? { tools: toAnthropicTools(request.tools) as Anthropic.Tool[] }
      : {}),
  };
}

/** Convert a Koi ModelRequest to streaming params. */
export function toAnthropicStreamParams(
  request: ModelRequest,
  defaults: RequestDefaults,
): Anthropic.MessageCreateParamsStreaming {
  return {
    ...toAnthropicParams(request, defaults),
    stream: true,
  } as Anthropic.MessageCreateParamsStreaming;
}
