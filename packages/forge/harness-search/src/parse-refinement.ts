/**
 * Lightweight code block extraction for refinement outputs.
 *
 * This is simpler than harness-synth's parser — it just extracts
 * the code block without full structural validation (that's
 * forge-verifier's job).
 */

/**
 * Extract the first code block from LLM refinement output.
 * Returns null if no code block found — caller should keep current code.
 */
export function parseRefinementOutput(raw: string): string | null {
  const pattern = /```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/;
  const match = pattern.exec(raw);
  const code = match?.[1]?.trim();
  return code !== undefined && code.length > 0 ? code : null;
}
