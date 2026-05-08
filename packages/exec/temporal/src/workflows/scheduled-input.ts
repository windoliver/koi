import type { IncomingMessage, ScheduledInputPayload } from "../types.js";

export const SCHEDULED_INPUT_SIGNAL_NAME = "scheduled-input" as const;

export function scheduledInputToMessages(
  input: ScheduledInputPayload,
  seed: string,
  now: number = Date.now(),
): readonly IncomingMessage[] {
  switch (input.kind) {
    case "text":
      return [
        {
          id: `${seed}:0`,
          senderId: "scheduler",
          content: [{ kind: "text", text: input.text }],
          timestamp: now,
        },
      ];
    case "messages":
      return input.messages.map(
        (message, index): IncomingMessage => ({
          id: `${seed}:${index}`,
          senderId: message.senderId,
          content: [...message.content],
          timestamp: message.timestamp,
          threadId: message.threadId,
          metadata: message.metadata as Record<string, unknown> | undefined,
          pinned: message.pinned,
        }),
      );
    case "resume":
      return [
        {
          id: `${seed}:resume`,
          senderId: "scheduler",
          content: [],
          timestamp: now,
          resumeState: input.state,
        },
      ];
  }
}
