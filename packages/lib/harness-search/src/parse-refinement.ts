/**
 * Lightweight code-block extraction for refinement outputs.
 *
 * Simpler than @koi/harness-synth's parser — extracts the first fenced
 * block without full structural validation. Structural / schema checks
 * are the verifier's job (forge-verifier), invoked downstream of search.
 */

const CODE_FENCE = /```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/;

/**
 * Extract the first fenced code block from refinement output.
 * Returns null when no block is present — callers retain prior code.
 */
export function parseRefinementOutput(raw: string): string | null {
  const match = CODE_FENCE.exec(raw);
  const code = match?.[1]?.trim();
  return code !== undefined && code.length > 0 ? code : null;
}
