/**
 * @-reference parser and file content resolver for @-mention injection (#10).
 *
 * Parses @path and @path#L10-20 references from user input, reads the
 * referenced files, and produces a rewritten message with file content
 * injected as context. The model sees the file content directly without
 * needing to call Glob or fs_read.
 *
 * Design: CC-style synthetic tool result injection. File content is
 * presented as if the model already called fs_read, so the model's
 * tool-calling budget isn't wasted on files the user explicitly referenced.
 *
 * Supported syntax:
 *   @path/to/file.ts          — full file
 *   @path/to/file.ts#L10      — single line
 *   @path/to/file.ts#L10-20   — line range
 *   @"path with spaces.ts"    — quoted path
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A parsed @-reference from user input. */
export interface AtReference {
  /** The raw text matched (e.g., '@src/math.ts#L10-20' or '@"path with spaces"'). */
  readonly raw: string;
  /** Start index of the match in the original text. */
  readonly matchIndex: number;
  /** Resolved file path (relative to cwd). */
  readonly filePath: string;
  /** Start line (1-based), undefined for full file. */
  readonly lineStart: number | undefined;
  /** End line (1-based, inclusive), undefined for full file or single line. */
  readonly lineEnd: number | undefined;
}

/** Result of resolving @-references in a message. */
export interface ResolvedAtReferences {
  /** User text with @-references stripped (the actual question). */
  readonly cleanText: string;
  /** Successfully resolved file contents, formatted for injection. */
  readonly injections: readonly FileInjection[];
}

/** A resolved file ready for injection into model context. */
export interface FileInjection {
  /** File path (relative to cwd). */
  readonly filePath: string;
  /** File content (possibly truncated to line range). */
  readonly content: string;
  /** Line range if specified. */
  readonly lineStart: number | undefined;
  readonly lineEnd: number | undefined;
  /** True if the content was truncated due to size limits. */
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes to read from a single file. */
const MAX_FILE_BYTES = 100_000;

/** Maximum lines to include from a single file. */
const MAX_LINES = 2_000;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Regex for @-references. Two patterns:
 * 1. Quoted: @"path with spaces"  (optionally followed by #L range)
 * 2. Unquoted: @non-whitespace    (optionally followed by #L range)
 *
 * Must be preceded by whitespace or at start of string.
 */
const AT_QUOTED_RE = /(?:^|(?<=\s))@"([^"]+)"(?:#L(\d+)(?:-(\d+))?)?/g;
const AT_UNQUOTED_RE = /(?:^|(?<=\s))@(\S+?)(?:#L(\d+)(?:-(\d+))?)?(?=\s|$)/g;

/**
 * Parse @-references from user input text.
 * Returns the references found and the text with @-references removed.
 */
export function parseAtReferences(text: string): readonly AtReference[] {
  const refs: AtReference[] = [];

  // Quoted paths first (higher priority)
  for (const match of text.matchAll(AT_QUOTED_RE)) {
    const filePath = match[1]!;
    const lineStart = match[2] !== undefined ? Number.parseInt(match[2], 10) : undefined;
    const lineEnd = match[3] !== undefined ? Number.parseInt(match[3], 10) : undefined;
    refs.push({
      raw: match[0],
      matchIndex: match.index,
      filePath,
      lineStart,
      lineEnd: lineEnd ?? (lineStart !== undefined ? lineStart : undefined),
    });
  }

  // Unquoted paths (skip any that overlap with quoted matches)
  const quotedStarts = new Set(refs.map((r) => r.matchIndex));
  for (const match of text.matchAll(AT_UNQUOTED_RE)) {
    // Skip if this position was already captured by a quoted match
    if (quotedStarts.has(match.index)) continue;
    const filePath = match[1]!;
    // Skip if it starts with a quote (partial match of a quoted ref)
    if (filePath.startsWith('"')) continue;
    // Skip if it looks like an email (contains @ before the match)
    if (filePath.includes("@")) continue;
    const lineStart = match[2] !== undefined ? Number.parseInt(match[2], 10) : undefined;
    const lineEnd = match[3] !== undefined ? Number.parseInt(match[3], 10) : undefined;
    refs.push({
      raw: match[0],
      matchIndex: match.index,
      filePath,
      lineStart,
      lineEnd: lineEnd ?? (lineStart !== undefined ? lineStart : undefined),
    });
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve @-references: parse refs from text, read files, return injections.
 *
 * @param text - Raw user input (e.g., "@package.json explain deps")
 * @param cwd  - Working directory for resolving relative paths
 * @returns Clean text + file injections ready for model context
 */
export function resolveAtReferences(text: string, cwd: string): ResolvedAtReferences {
  const refs = parseAtReferences(text);

  if (refs.length === 0) {
    return { cleanText: text, injections: [] };
  }

  const injections: FileInjection[] = [];

  // Strip @-references from text by index (reverse order to preserve positions).
  // Using indices instead of String.replace avoids removing the wrong occurrence
  // when the same token appears in non-reference text.
  const sortedByIndex = [...refs].sort((a, b) => b.matchIndex - a.matchIndex);
  let cleanText = text;
  for (const ref of sortedByIndex) {
    cleanText =
      cleanText.slice(0, ref.matchIndex) + cleanText.slice(ref.matchIndex + ref.raw.length);
  }
  // Collapse multiple spaces and trim
  cleanText = cleanText.replace(/\s{2,}/g, " ").trim();

  // Read each referenced file (with path containment check)
  for (const ref of refs) {
    // Reject absolute paths — only relative paths within cwd are allowed
    if (isAbsolute(ref.filePath)) continue;

    const absolutePath = resolve(cwd, ref.filePath);

    // Resolve symlinks and verify the real path is still within cwd.
    // Prevents ../../../etc/passwd traversal and symlink escape.
    // Read the validated realPath (not absolutePath) to close the TOCTOU
    // window — the path that passed containment is the path that gets read.
    let validatedPath: string;
    try {
      const realPath = realpathSync(absolutePath);
      const realCwd = realpathSync(cwd);
      if (!realPath.startsWith(`${realCwd}/`) && realPath !== realCwd) continue;
      validatedPath = realPath;
    } catch {
      // File doesn't exist or unresolvable — skip
      continue;
    }

    try {
      // Stat check: reject files exceeding 10x the cap to avoid reading
      // multi-GB files into memory. Files between 1x-10x cap are read and
      // truncated; files over 10x are skipped entirely.
      const MAX_READ_BYTES = MAX_FILE_BYTES * 10;
      const stat = statSync(validatedPath);
      if (stat.size > MAX_READ_BYTES && ref.lineStart === undefined) continue;

      const raw = readFileSync(validatedPath, { encoding: "utf8" });
      let content: string;
      let truncated = false;

      if (ref.lineStart !== undefined) {
        // Line range extraction (1-based)
        const lines = raw.split("\n");
        const start = Math.max(0, ref.lineStart - 1);
        const end = ref.lineEnd !== undefined ? Math.min(lines.length, ref.lineEnd) : start + 1;
        content = lines.slice(start, end).join("\n");
      } else {
        // Full file with size/line cap
        if (raw.length > MAX_FILE_BYTES) {
          content = raw.slice(0, MAX_FILE_BYTES);
          truncated = true;
        } else {
          const lines = raw.split("\n");
          if (lines.length > MAX_LINES) {
            content = lines.slice(0, MAX_LINES).join("\n");
            truncated = true;
          } else {
            content = raw;
          }
        }
      }

      injections.push({
        filePath: ref.filePath,
        content,
        lineStart: ref.lineStart,
        lineEnd: ref.lineEnd,
        truncated,
      });
    } catch {
      // File not found or unreadable — skip silently (model can still
      // try to find it via tools if needed)
    }
  }

  return { cleanText, injections };
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

/**
 * Format resolved @-references as a model-ready message string.
 *
 * Produces CC-style synthetic tool-result context: each file is presented
 * as if the model already called fs_read. The model sees the content
 * directly and doesn't waste tool calls re-reading referenced files.
 *
 * @param resolved - Output from resolveAtReferences()
 * @returns Formatted message string ready for runtime.run({ kind: "text", text })
 */
export function formatAtReferencesForModel(resolved: ResolvedAtReferences): string {
  if (resolved.injections.length === 0) {
    return resolved.cleanText;
  }

  const sections: string[] = [];

  for (const injection of resolved.injections) {
    const rangeDesc =
      injection.lineStart !== undefined
        ? injection.lineStart === injection.lineEnd
          ? ` (line ${injection.lineStart})`
          : ` (lines ${injection.lineStart}-${injection.lineEnd})`
        : "";
    const truncNote = injection.truncated ? "\n[Note: file was truncated due to size]" : "";

    sections.push(
      `<file path="${injection.filePath}"${rangeDesc}>\n${injection.content}${truncNote}\n</file>`,
    );
  }

  // File context first, then the user's actual question
  return `${sections.join("\n\n")}\n\n${resolved.cleanText}`;
}
