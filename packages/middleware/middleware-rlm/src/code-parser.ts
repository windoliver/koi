/**
 * Code block parser for code-execution mode.
 *
 * Extracts the first JavaScript code block from a model's response text.
 * Supports triple-backtick fenced blocks with `javascript` or `js` language tags.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeBlock {
  readonly language: string;
  readonly code: string;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const FENCE_REGEX_GLOBAL = /```(\w+)\s*\n([\s\S]*?)```/g;
const JS_LANGUAGES = new Set(["javascript", "js"]);

/**
 * Extract the first JavaScript code block from model response text.
 *
 * Scans all fenced code blocks and returns the first one with a JS language tag.
 * Returns `undefined` if no fenced JS block is found.
 */
export function extractCodeBlock(text: string): CodeBlock | undefined {
  for (const match of text.matchAll(FENCE_REGEX_GLOBAL)) {
    const language = match[1];
    const code = match[2];
    if (language === undefined || code === undefined) continue;
    if (!JS_LANGUAGES.has(language.toLowerCase())) continue;

    const trimmed = code.trim();
    if (trimmed.length === 0) continue;

    return { language: language.toLowerCase(), code: trimmed };
  }
  return undefined;
}
