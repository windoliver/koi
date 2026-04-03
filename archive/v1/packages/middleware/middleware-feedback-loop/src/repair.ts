/**
 * Default repair strategy — appends assistant response + error summary to retry request.
 */

import type { InboundMessage } from "@koi/core/message";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import type { RepairStrategy, ValidationError } from "./types.js";

/** Formats validation errors as structured text for model feedback. */
export function formatErrors(errors: readonly ValidationError[]): string {
  return errors
    .map((e) => {
      const parts = [`[${e.validator}]`];
      if (e.path !== undefined) parts.push(`at ${e.path}`);
      parts.push(e.message);
      return parts.join(" ");
    })
    .join("\n");
}

/** Default repair: appends assistant response + error summary as messages (~200 tokens). */
export const defaultRepairStrategy: RepairStrategy = {
  buildRetryRequest(
    original: ModelRequest,
    response: ModelResponse,
    errors: readonly ValidationError[],
    _attempt: number,
  ): ModelRequest {
    const assistantMessage: InboundMessage = {
      senderId: "assistant",
      timestamp: Date.now(),
      content: [{ kind: "text", text: response.content }],
    };

    const errorMessage: InboundMessage = {
      senderId: "system:feedback-loop",
      timestamp: Date.now(),
      content: [
        {
          kind: "text",
          text: `Your previous response had validation errors. Please fix them and try again:\n\n${formatErrors(errors)}`,
        },
      ],
    };

    return {
      ...original,
      messages: [...original.messages, assistantMessage, errorMessage],
    };
  },
};
