/**
 * Types for the ask-user tool.
 *
 * L2 — imports from @koi/core only.
 */

import type { ToolDescriptor } from "@koi/core/ecs";
import type { ElicitationQuestion, ElicitationResult } from "@koi/core/elicitation";

/**
 * Callback that sends a structured question to the user and
 * returns their response. The handler is responsible for rendering
 * the question (CLI, web UI, etc.) and collecting the answer.
 *
 * The signal is aborted when the timeout expires or the engine stops.
 * Implementations should respect it to avoid blocking indefinitely.
 */
export type ElicitationHandler = (
  question: ElicitationQuestion,
  signal: AbortSignal,
) => Promise<ElicitationResult>;

/** Default timeout for user response (5 minutes). */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** Default maximum number of options per question. */
export const DEFAULT_MAX_OPTIONS = 6;

/** Configuration for the ask-user tool provider. */
export interface AskUserConfig {
  /** Callback to send question to user and await response. */
  readonly handler: ElicitationHandler;
  /** Maximum wait time for user response in ms. Default: 300,000 (5 min). */
  readonly timeoutMs?: number | undefined;
  /** Maximum number of options per question. Default: 6. */
  readonly maxOptions?: number | undefined;
}

/** Tool descriptor exposed to the model for the ask_user tool. */
export const ASK_USER_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: "ask_user",
  description:
    "Ask the user a structured question with predefined options. Use when you need user input, clarification, or a decision before proceeding. The user can select from the provided options or give a custom free-text answer.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user. Should be clear and end with a question mark.",
      },
      header: {
        type: "string",
        description:
          "Short label for the question (max 12 characters). E.g., 'Approach', 'Library'.",
      },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Concise choice text (1-5 words)",
            },
            description: {
              type: "string",
              description: "Explanation of this choice",
            },
          },
          required: ["label", "description"],
        },
        description: "2+ predefined choices for the user",
        minItems: 2,
      },
      multiSelect: {
        type: "boolean",
        description: "Whether the user can select multiple options. Default: false.",
      },
    },
    required: ["question", "options"],
  },
};
