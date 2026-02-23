/**
 * Soul/user content resolution — reads markdown files or inline text,
 * concatenates directory contents, and enforces token budgets.
 */

import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Resolved soul/user content ready for injection. */
export interface ResolvedContent {
  readonly text: string;
  readonly tokens: number;
  readonly sources: readonly string[];
  readonly warnings: readonly string[];
}

/** Options for resolving a soul or user field from manifest config. */
export interface ResolveOptions {
  readonly input: string;
  readonly maxTokens: number;
  readonly label: "soul" | "user";
  readonly basePath: string;
}

/** Approximate chars per token — same heuristic as @koi/context. */
const CHARS_PER_TOKEN = 4;

/** Files to look for in a soul directory, in order. */
const SOUL_DIR_FILES = ["SOUL.md", "STYLE.md", "INSTRUCTIONS.md"] as const;

/** Section headers for directory mode concatenation. */
const SECTION_HEADERS: Readonly<Record<string, string>> = {
  "SOUL.md": "## Soul",
  "STYLE.md": "## Style",
  "INSTRUCTIONS.md": "## Instructions",
} as const;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function detectInputMode(input: string): "inline" | "file" | "directory" {
  if (input.includes("\n")) return "inline";
  // Heuristic: if it ends with / or has no extension, treat as potential directory
  // Actual directory check happens at resolution time
  return "file";
}

async function readFileContent(filePath: string): Promise<string | undefined> {
  try {
    return await Bun.file(filePath).text();
  } catch {
    return undefined;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

function truncateToTokenBudget(
  text: string,
  maxTokens: number,
  warnings: string[],
  label: string,
): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  warnings.push(`${label} content truncated from ~${estimateTokens(text)} to ${maxTokens} tokens`);
  return text.slice(0, maxChars);
}

async function resolveDirectoryContent(
  dirPath: string,
  label: string,
): Promise<{
  readonly text: string;
  readonly sources: readonly string[];
  readonly warnings: readonly string[];
}> {
  const warnings: string[] = [];
  const sources: string[] = [];
  const sections: string[] = [];

  // SOUL.md is required
  const soulPath = join(dirPath, "SOUL.md");
  const soulContent = await readFileContent(soulPath);
  if (soulContent === undefined) {
    return {
      text: "",
      sources: [],
      warnings: [`${label} directory missing required SOUL.md: ${dirPath}`],
    };
  }

  if (soulContent.length === 0) {
    warnings.push(`${label} SOUL.md is empty: ${soulPath}`);
  }

  sources.push(soulPath);
  sections.push(`${SECTION_HEADERS["SOUL.md"]}\n${soulContent}`);

  // Optional files
  for (const fileName of SOUL_DIR_FILES.slice(1)) {
    const filePath = join(dirPath, fileName);
    const content = await readFileContent(filePath);
    if (content !== undefined) {
      sources.push(filePath);
      if (content.length > 0) {
        sections.push(`${SECTION_HEADERS[fileName]}\n${content}`);
      } else {
        warnings.push(`${label} ${fileName} is empty: ${filePath}`);
      }
    }
  }

  return { text: sections.join("\n\n"), sources, warnings };
}

/**
 * Resolves soul content from a manifest config value.
 *
 * Supports three input modes:
 * - Inline: string containing newlines → used directly
 * - File: path to a single .md file
 * - Directory: path to a directory with SOUL.md (required), STYLE.md, INSTRUCTIONS.md (optional)
 */
export async function resolveSoulContent(options: ResolveOptions): Promise<ResolvedContent> {
  const { input, maxTokens, label, basePath } = options;
  const warnings: string[] = [];

  const mode = detectInputMode(input);

  if (mode === "inline") {
    const text = truncateToTokenBudget(input, maxTokens, warnings, label);
    return {
      text,
      tokens: estimateTokens(text),
      sources: ["inline"],
      warnings,
    };
  }

  // Resolve relative paths against basePath
  const resolvedPath = resolve(basePath, input);

  // Check if it's a directory
  if (await isDirectory(resolvedPath)) {
    const result = await resolveDirectoryContent(resolvedPath, label);
    // Directory missing required SOUL.md → error in warnings, empty text
    if (result.text.length === 0) {
      return {
        text: "",
        tokens: 0,
        sources: result.sources,
        warnings: result.warnings,
      };
    }
    const text = truncateToTokenBudget(result.text, maxTokens, warnings, label);
    return {
      text,
      tokens: estimateTokens(text),
      sources: result.sources,
      warnings: [...result.warnings, ...warnings],
    };
  }

  // Single file mode
  const content = await readFileContent(resolvedPath);
  if (content === undefined) {
    return {
      text: "",
      tokens: 0,
      sources: [],
      warnings: [`${label} file not found: ${resolvedPath}`],
    };
  }

  if (content.length === 0) {
    warnings.push(`${label} file is empty: ${resolvedPath}`);
  }

  const text = truncateToTokenBudget(content, maxTokens, warnings, label);
  return {
    text,
    tokens: estimateTokens(text),
    sources: [resolvedPath],
    warnings,
  };
}

/**
 * Resolves user content from a manifest config value.
 *
 * Same as soul resolution but:
 * - No directory mode (user is always a single file or inline)
 * - Missing file → warning + empty result (not an error)
 */
export async function resolveUserContent(options: ResolveOptions): Promise<ResolvedContent> {
  const { input, maxTokens, label, basePath } = options;
  const warnings: string[] = [];

  const mode = detectInputMode(input);

  if (mode === "inline") {
    const text = truncateToTokenBudget(input, maxTokens, warnings, label);
    return {
      text,
      tokens: estimateTokens(text),
      sources: ["inline"],
      warnings,
    };
  }

  const resolvedPath = resolve(basePath, input);

  const content = await readFileContent(resolvedPath);
  if (content === undefined) {
    return {
      text: "",
      tokens: 0,
      sources: [],
      warnings: [`${label} file not found: ${resolvedPath}`],
    };
  }

  if (content.length === 0) {
    warnings.push(`${label} file is empty: ${resolvedPath}`);
  }

  const text = truncateToTokenBudget(content, maxTokens, warnings, label);
  return {
    text,
    tokens: estimateTokens(text),
    sources: [resolvedPath],
    warnings,
  };
}
