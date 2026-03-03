/**
 * Elicitation types — structured user questioning contract (Layer 0).
 *
 * Defines the data shapes for asking users structured questions
 * (multi-choice or free-text) and receiving their responses.
 * No runtime code — types only.
 */

/** A single predefined choice within a question. */
export interface ElicitationOption {
  /** Concise choice text (1-5 words). */
  readonly label: string;
  /** Explanation of what this option means or what happens if chosen. */
  readonly description: string;
}

/** A structured question to present to a user. */
export interface ElicitationQuestion {
  /** Full question text. Should be clear, specific, and end with a question mark. */
  readonly question: string;
  /** Short label for UI grouping (max 12 chars). E.g., "Approach", "Library". */
  readonly header?: string | undefined;
  /** Predefined choices for the user (2+). */
  readonly options: readonly ElicitationOption[];
  /** Whether the user can select multiple options. Default: false. */
  readonly multiSelect?: boolean | undefined;
}

/** The user's response to an elicitation question. */
export interface ElicitationResult {
  /** Labels of selected options (empty if free-text only). */
  readonly selected: readonly string[];
  /** Custom text input when the user chooses "Other" or types freely. */
  readonly freeText?: string | undefined;
}
