/**
 * Tool factory for `AskUserQuestion` — structured user elicitation.
 *
 * The tool itself is stateless: it delegates all pause/answer logic to the
 * `elicit` callback provided by the harness. The harness is responsible for
 * suspending the agent loop and injecting answers back when the user responds.
 *
 * Disabled when `isChannelsActive()` returns true (no TUI available for dialog).
 */

import type {
  ElicitationQuestion,
  ElicitationResult,
  JsonObject,
  Tool,
  ToolPolicy,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AskUserToolConfig {
  /**
   * Harness-provided elicitation function. Called with the parsed questions;
   * resolves with user-selected answers once the dialog is dismissed.
   */
  readonly elicit: (
    questions: readonly ElicitationQuestion[],
  ) => Promise<readonly ElicitationResult[]>;
  /**
   * Returns true if the agent is running in channel mode (Telegram, Discord, etc.)
   * where no TUI dialog is available. Tool is disabled when true.
   */
  readonly isChannelsActive?: (() => boolean) | undefined;
  readonly policy?: ToolPolicy | undefined;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function parseQuestion(
  raw: unknown,
  index: number,
): ElicitationQuestion | { error: string; code: "VALIDATION" } {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `questions[${String(index)}] must be an object`, code: "VALIDATION" };
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.question !== "string" || obj.question.length === 0) {
    return {
      error: `questions[${String(index)}].question must be a non-empty string`,
      code: "VALIDATION",
    };
  }
  if (!Array.isArray(obj.options) || obj.options.length < 2) {
    return {
      error: `questions[${String(index)}].options must be an array of at least 2 choices`,
      code: "VALIDATION",
    };
  }
  for (let j = 0; j < obj.options.length; j++) {
    const opt = obj.options[j] as Record<string, unknown> | undefined;
    if (!opt || typeof opt.label !== "string" || opt.label.length === 0) {
      return {
        error: `questions[${String(index)}].options[${String(j)}].label must be a non-empty string`,
        code: "VALIDATION",
      };
    }
    if (typeof opt.description !== "string") {
      return {
        error: `questions[${String(index)}].options[${String(j)}].description must be a string`,
        code: "VALIDATION",
      };
    }
  }
  if (obj.header !== undefined && typeof obj.header !== "string") {
    return {
      error: `questions[${String(index)}].header must be a string`,
      code: "VALIDATION",
    };
  }
  if (obj.multiSelect !== undefined && typeof obj.multiSelect !== "boolean") {
    return {
      error: `questions[${String(index)}].multiSelect must be a boolean`,
      code: "VALIDATION",
    };
  }

  return {
    question: obj.question,
    options: (obj.options as Array<Record<string, unknown>>).map((o) => ({
      label: o.label as string,
      description: o.description as string,
    })),
    ...(obj.header !== undefined && { header: obj.header as string }),
    ...(obj.multiSelect !== undefined && { multiSelect: obj.multiSelect as boolean }),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAskUserTool(config: AskUserToolConfig): Tool {
  const { elicit, isChannelsActive, policy = DEFAULT_UNSANDBOXED_POLICY } = config;

  return {
    descriptor: {
      name: "AskUserQuestion",
      description:
        "Present structured questions to the user and wait for their answers before continuing. " +
        "Use when you need to clarify approach, preferences, or missing information. " +
        "Each question must offer 2+ predefined choices. Limit to 4 questions per call.",
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "List of questions to present (1–4).",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                question: {
                  type: "string",
                  description: "Full question text, ending with a question mark.",
                },
                header: {
                  type: "string",
                  description: "Short UI label for grouping (max 12 chars), e.g. 'Approach'.",
                },
                options: {
                  type: "array",
                  description: "Predefined choices (2+).",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string", description: "Concise option text (1–5 words)." },
                      description: { type: "string", description: "What this option means." },
                    },
                    required: ["label", "description"],
                  },
                },
                multiSelect: {
                  type: "boolean",
                  description: "Allow selecting multiple options (default: false).",
                },
              },
              required: ["question", "options"],
            },
          },
        },
        required: ["questions"],
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (args: JsonObject): Promise<unknown> => {
      if (isChannelsActive?.() === true) {
        return {
          error:
            "AskUserQuestion is unavailable in channel mode — no TUI dialog available. " +
            "Ask the user via the channel's native messaging interface instead.",
          code: "UNAVAILABLE",
        };
      }

      const raw = args.questions;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { error: "questions must be a non-empty array", code: "VALIDATION" };
      }
      if (raw.length > 4) {
        return { error: "questions must contain at most 4 items", code: "VALIDATION" };
      }

      const questions: ElicitationQuestion[] = [];
      for (let i = 0; i < raw.length; i++) {
        const parsed = parseQuestion(raw[i], i);
        if ("error" in parsed) return parsed;
        questions.push(parsed);
      }

      const results = await elicit(questions);

      return {
        answers: questions.map((q, i) => {
          const result = results[i];
          return {
            question: q.question,
            ...(result !== undefined && {
              selected: result.selected,
              ...(result.freeText !== undefined && { freeText: result.freeText }),
            }),
          };
        }),
      };
    },
  };
}
