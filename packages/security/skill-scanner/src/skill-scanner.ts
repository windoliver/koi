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

// Matches any opening fence (``` or ~~~ or longer variants, optionally indented by up to 3
// spaces as allowed by CommonMark), optionally followed by a lang/info-string.
// We capture the fence char (group 1) and the first word of the info-string (group 2).
const OPENING_FENCE_RE = /^ {0,3}([`~]{3,})\s*(\S*)/;
// Closing fence regexes: homogeneous runs only (no mixed ` and ~).
// Per CommonMark §4.5, the closing fence must be the same character repeated ≥ openLen times.
const CLOSING_FENCE_BACKTICK_RE = /^ {0,3}(`{3,})\s*$/;
const CLOSING_FENCE_TILDE_RE = /^ {0,3}(~{3,})\s*$/;
function isClosingFence(line: string, fenceChar: string, openLen: number): boolean {
  const re = fenceChar === "~" ? CLOSING_FENCE_TILDE_RE : CLOSING_FENCE_BACKTICK_RE;
  const match = re.exec(line);
  if (match === null) return false;
  return (match[1] ?? "").length >= openLen;
}

const LANG_TO_EXT: Readonly<Record<string, string>> = {
  js: ".js",
  javascript: ".js",
  typescript: ".ts",
  ts: ".ts",
  jsx: ".jsx",
  tsx: ".tsx",
};

/**
 * Languages that are unambiguously non-executable markup/config.
 * Everything else (including unknown tags) is scanned as TypeScript — fail closed.
 */
const SKIP_LANGS = new Set([
  "text",
  "plaintext",
  "txt",
  "markdown",
  "md",
  "html",
  "css",
  "scss",
  "less",
  "yaml",
  "yml",
  "json",
  "toml",
  "ini",
  "xml",
  "svg",
  "sql",
  "graphql",
  "diff",
  "patch",
  "sh",
  "bash",
  "zsh",
  "fish",
  "powershell",
  "ps1",
  "ruby",
  "rb",
  "python",
  "py",
  "go",
  "rust",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "cs",
  "swift",
  "kotlin",
  "php",
]);

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
  // let: opening fence character and length for CommonMark-compliant closing fence matching
  let openFenceChar = "`";
  let openFenceLen = 3;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    if (!inBlock) {
      const openMatch = OPENING_FENCE_RE.exec(line);
      if (openMatch !== null) {
        const fence = openMatch[1] ?? "```";
        const lang = (openMatch[2] ?? "").toLowerCase();
        // Fail-closed: scan everything EXCEPT unambiguously non-executable langs.
        // Unknown or empty lang tags are treated as JS/TS and scanned.
        if (!SKIP_LANGS.has(lang)) {
          inBlock = true;
          blockLang = lang;
          blockStartLine = i + 1; // 1-based line number of the opening fence
          blockLines = [];
          openFenceChar = fence[0] ?? "`";
          openFenceLen = fence.length;
        }
      }
    } else if (isClosingFence(line, openFenceChar, openFenceLen)) {
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

  // CommonMark §4.5: unclosed fence runs to end of document — emit remaining content.
  // Fail-closed: scan the trailing code so attackers can't smuggle by omitting the closer.
  if (inBlock) {
    const code = blockLines.join("\n");
    if (code.trim().length > 0) {
      const ext = LANG_TO_EXT[blockLang] ?? ".ts";
      blocks.push({
        code: `${code}\n`,
        filename: `block-${blocks.length}${ext}`,
        startLine: blockStartLine,
      });
    }
  }

  return blocks;
}
