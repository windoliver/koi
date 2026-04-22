import type { InboundMessage } from "@koi/core/message";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import type { RepairStrategy, ValidationError } from "./types.js";

const FEEDBACK_SENDER_ID = "system:feedback-loop";

export function formatErrors(errors: readonly ValidationError[]): string {
  return errors
    .map((e) => {
      const parts: string[] = [`[${e.validator}]`];
      if (e.path !== undefined) parts.push(`at ${e.path}`);
      parts.push(e.message);
      return parts.join(" ");
    })
    .join("\n");
}

function buildFeedbackMessage(errors: readonly ValidationError[]): InboundMessage {
  return {
    senderId: FEEDBACK_SENDER_ID,
    timestamp: Date.now(),
    content: [
      {
        kind: "text",
        text: `Validation failed. Fix these errors and try again:\n\n${formatErrors(errors)}`,
      },
    ],
  };
}

export const defaultRepairStrategy: RepairStrategy = {
  buildRetryRequest(
    currentRequest: ModelRequest,
    errors: readonly ValidationError[],
    ctx: {
      readonly attempt: number;
      readonly response: ModelResponse;
      readonly feedbackMessageId: string | undefined;
    },
  ): { readonly request: ModelRequest; readonly feedbackMessageId: string } {
    const feedback = buildFeedbackMessage(errors);
    // Spread to avoid mutating the original array
    const messages = [...currentRequest.messages];

    const slotIndex =
      ctx.feedbackMessageId !== undefined ? parseInt(ctx.feedbackMessageId, 10) : NaN;
    const validIndex = !Number.isNaN(slotIndex) && slotIndex >= 0 && slotIndex < messages.length;

    if (validIndex) {
      messages[slotIndex] = feedback;
    } else {
      messages.push(feedback);
    }

    const newIndex = validIndex ? slotIndex : messages.length - 1;
    return {
      request: { ...currentRequest, messages },
      feedbackMessageId: String(newIndex),
    };
  },
};
