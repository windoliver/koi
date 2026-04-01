/**
 * Constants for @koi/filesystem — tool names and SDK mappings.
 */

import type { SkillComponent } from "@koi/core";

/** Default tool name prefix for filesystem tools. */
export const DEFAULT_PREFIX = "fs" as const;

/** All filesystem operation names. */
export const OPERATIONS = ["read", "write", "edit", "list", "search"] as const;

export type FileSystemOperation = (typeof OPERATIONS)[number];

/**
 * Built-in Claude SDK tools to block when using Koi filesystem.
 * Pass to `ClaudeAdapterConfig.disallowedTools` to prevent the SDK
 * from exposing its own file tools alongside the Koi ones.
 */
export const CLAUDE_SDK_FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"] as const;

/** Skill component name for filesystem behavioral guidance. */
export const FS_SKILL_NAME = "filesystem" as const;

/**
 * Markdown content for the filesystem skill component.
 * Teaches agents when to use each filesystem tool and how to do so safely.
 *
 * References the default prefix (`fs_*`). Agents using a custom prefix
 * should substitute the appropriate tool names when applying this guidance.
 */
export const FS_SKILL_CONTENT: string = `
# Filesystem — tool selection and safety

## Tool selection guide

### fs_edit vs fs_write

- **fs_edit** — in-place modification of an *existing* file using search-and-replace hunks.
  - Use when: you know the exact text to replace and the file already exists.
  - Supports multiple \`{ oldText, newText }\` hunks in a single call.
  - Fails with NOT_FOUND if \`oldText\` is not present — prevents silent overwrites.
  - Prefer \`dryRun: true\` to preview changes before committing.

- **fs_write** — full content replacement of a file.
  - Use when: creating a new file, or replacing the entire content of an existing file.
  - Creates the file (and parent directories with \`createDirectories: true\`) if it does not exist.
  - Overwrites without confirmation by default — set \`overwrite: false\` to guard existing files.
  - Do NOT use fs_write to make small edits to large files; use fs_edit instead.

### fs_search vs fs_list

- **fs_search** — content search within files using a text or regex pattern.
  - Use when: "find all occurrences of X", "which files contain Y", "show me where Z is used".
  - Returns matching file paths and the matching lines.
  - Much faster than reading every file when you know what you are looking for.

- **fs_list** — directory structure exploration.
  - Use when: "what files exist here", "show me the directory tree", "list contents of a folder".
  - Does not read file content — use fs_read or fs_search for that.

## Read before edit

Always call **fs_read** before **fs_edit**. Confirm the exact \`oldText\` exists in the
current file before submitting an edit hunk. If the file has changed since your last read,
the edit will fail with NOT_FOUND. Reading first also reveals context that may change your edit.

## Path safety

- Always use **absolute paths**. Relative paths behave differently across backends and working
  directories and are a common source of bugs.
- Before \`fs_write\` (which overwrites by default), read the existing file to confirm you
  intend to replace its entire content.
- Never construct file paths via string concatenation from untrusted input — pass path values
  only through the tool's \`path\` parameter.
`.trim();

/**
 * Additional skill content section for when a semantic search retriever is available.
 * Appended to FS_SKILL_CONTENT to teach agents when to prefer semantic vs pattern search.
 */
export const FS_SEMANTIC_SEARCH_SKILL_SECTION: string = `

### fs_search vs fs_semantic_search

- **fs_search** — pattern-based content search (exact text or regex).
  - Use when: you know the exact string, symbol name, or regex pattern to find.
  - Returns matching lines with file paths — fast and precise.

- **fs_semantic_search** — ranked semantic search over indexed file content.
  - Use when: you want to find conceptually related code or text, not an exact match.
  - Returns results ranked by relevance score.
  - Good for: "find functions related to authentication", "code that handles retries".
  - NOT for: exact symbol lookup, known patterns, or grep-style matching — use fs_search instead.
`.trim();

/**
 * Creates a SkillComponent with or without semantic search guidance.
 * When `hasRetriever` is true, the skill content includes additional guidance
 * for choosing between fs_search and fs_semantic_search.
 */
export function createFsSkill(hasRetriever: boolean): SkillComponent {
  const content = hasRetriever
    ? `${FS_SKILL_CONTENT}\n\n${FS_SEMANTIC_SEARCH_SKILL_SECTION}`
    : FS_SKILL_CONTENT;

  return {
    name: FS_SKILL_NAME,
    description: hasRetriever
      ? "When to use fs_edit vs fs_write, fs_search vs fs_semantic_search vs fs_list, read-before-edit, and path safety"
      : "When to use fs_edit vs fs_write, fs_search vs fs_list, read-before-edit, and path safety",
    content,
    tags: ["filesystem", "best-practices"],
  };
}

/**
 * Pre-built SkillComponent for filesystem behavioral guidance (no retriever).
 * Attached automatically by createFileSystemProvider.
 * Can also be used standalone with a custom ComponentProvider.
 */
export const FS_SKILL: SkillComponent = createFsSkill(false);
