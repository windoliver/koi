/**
 * Default feedback text injected when the stop gate blocks a filler turn.
 *
 * Kept as a separate module so consumers can re-export or replace it without
 * importing the full middleware surface.
 */

export const DEFAULT_FEEDBACK: string =
  "You produced a plan or status update without executing it. " +
  "The session is in strict-agentic mode — continue by taking the next concrete action " +
  "(call a tool or make a change). Do not describe what you will do; do it. " +
  "If you are blocked on external input, end your reply with a direct question to the user.";
