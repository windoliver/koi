import type { InboundMessage } from "@koi/core/message";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import type { RepairStrategy, ValidationError } from "./types.js";

// Use "user" role so feedback is a normal conversation turn, not a privileged system message.
// Adapters map "system:*" senders to the model's system role, which would elevate validator
// error text above the user conversation and can weaken instruction hierarchy.
const FEEDBACK_SENDER_ID = "user";

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
    const slotIndex =
      ctx.feedbackMessageId !== undefined ? parseInt(ctx.feedbackMessageId, 10) : NaN;
    const validIndex =
      !Number.isNaN(slotIndex) && slotIndex >= 0 && slotIndex < currentRequest.messages.length;

    const messages = validIndex
      ? currentRequest.messages.map((m, i) => (i === slotIndex ? feedback : m))
      : [...currentRequest.messages, feedback];

    const newIndex = validIndex ? slotIndex : messages.length - 1;
    return {
      request: { ...currentRequest, messages },
      feedbackMessageId: String(newIndex),
    };
  },
};
