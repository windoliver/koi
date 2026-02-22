/**
 * Markdown code block extractor and skill-specific checks.
 *
 * Extracts fenced code blocks from Markdown content for scanning,
 * and detects suspicious patterns in raw Markdown.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeBlock {
  readonly code: string;
  readonly filename: string;
  readonly startLine: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENING_FENCE_RE = /^```(js|javascript|typescript|ts|jsx|tsx)?\s*$/;
const CLOSING_FENCE_RE = /^```\s*$/;

const LANG_TO_EXT: Readonly<Record<string, string>> = {
  js: ".js",
  javascript: ".js",
  typescript: ".ts",
  ts: ".ts",
  jsx: ".jsx",
  tsx: ".tsx",
};

/** Supported fence languages. Empty string matches untagged code blocks (``` with no lang). */
const SUPPORTED_LANGS = new Set(["js", "javascript", "typescript", "ts", "jsx", "tsx", ""]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractCodeBlocks(markdown: string): readonly CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = markdown.split("\n");

  // let: state machine variables for line-by-line fence tracking
  let inBlock = false;
  let blockLang = "";
  let blockStartLine = 0;
  let blockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    if (!inBlock) {
      const openMatch = OPENING_FENCE_RE.exec(line);
      if (openMatch !== null) {
        const lang = openMatch[1] ?? "";
        // Only capture blocks with supported language tags (or untagged)
        if (SUPPORTED_LANGS.has(lang)) {
          inBlock = true;
          blockLang = lang;
          blockStartLine = i + 1; // 1-based line number of the opening fence
          blockLines = [];
        }
      }
    } else if (CLOSING_FENCE_RE.test(line)) {
      // Closing fence found
      const code = blockLines.join("\n");
      if (code.trim().length > 0) {
        const ext = LANG_TO_EXT[blockLang] ?? ".ts";
        blocks.push({
          code: `${code}\n`,
          filename: `block-${blocks.length}${ext}`,
          startLine: blockStartLine,
        });
      }
      inBlock = false;
      blockLines = [];
    } else {
      blockLines.push(line);
    }
  }

  return blocks;
}
