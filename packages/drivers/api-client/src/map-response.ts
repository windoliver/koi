/**
 * Map Anthropic SDK Message to Koi ModelResponse.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { ModelResponse } from "@koi/core";

/** Convert an Anthropic SDK Message to a Koi ModelResponse. */
export function fromAnthropicMessage(msg: Anthropic.Message): ModelResponse {
  const textContent = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    content: textContent,
    model: msg.model,
    usage: {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
    },
  };
}
