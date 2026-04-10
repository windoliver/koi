/**
 * File extension to LSP languageId mapping.
 *
 * Used to auto-detect languageId when opening documents.
 */

const EXTENSION_TO_LANGUAGE_ID = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".lua": "lua",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".json": "json",
  ".jsonc": "jsonc",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".md": "markdown",
  ".sql": "sql",
  ".zig": "zig",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".vue": "vue",
  ".svelte": "svelte",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Detects the LSP languageId from a file URI or path.
 *
 * Extracts the file extension and looks it up in the mapping.
 * Returns `undefined` if the extension is not recognized.
 */
export function detectLanguageId(uri: string): string | undefined {
  const dotIndex = uri.lastIndexOf(".");
  if (dotIndex === -1) return undefined;

  const ext = uri.slice(dotIndex).toLowerCase();
  return (EXTENSION_TO_LANGUAGE_ID as Readonly<Record<string, string>>)[ext];
}
