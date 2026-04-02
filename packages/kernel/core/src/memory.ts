/**
 * Memory record model — fact schema, categories, and frontmatter for
 * persistent agent memory.
 *
 * Models the CC-style file-per-memory system where each memory is a
 * Markdown file with YAML frontmatter (name, description, type) and
 * a body containing the memory content.
 *
 * Exception: branded type constructor (memoryRecordId) is permitted in L0
 * as a zero-logic identity cast for type safety.
 * Exception: pure functions (isMemoryType, parseMemoryFrontmatter,
 * serializeMemoryFrontmatter, validateMemoryRecord) are side-effect-free
 * data operations on L0 types.
 * Exception: ALL_MEMORY_TYPES and MEMORY_INDEX_MAX_LINES are pure readonly
 * data constants derived from L0 type definitions.
 */

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const __memoryRecordBrand: unique symbol;

/** Branded string type for memory record identifiers. */
export type MemoryRecordId = string & {
  readonly [__memoryRecordBrand]: "MemoryRecordId";
};

// ---------------------------------------------------------------------------
// Branded type constructors (zero-logic casts)
// ---------------------------------------------------------------------------

/** Create a branded MemoryRecordId from a plain string. */
export function memoryRecordId(raw: string): MemoryRecordId {
  return raw as MemoryRecordId;
}

// ---------------------------------------------------------------------------
// Memory type — the 4 categories
// ---------------------------------------------------------------------------

/**
 * Memory category type.
 *
 * - `user` — role, preferences, expertise, knowledge (always private)
 * - `feedback` — corrections AND validated approaches from the user
 * - `project` — ongoing work context, deadlines, decisions
 * - `reference` — pointers to external systems and resources
 */
export type MemoryType = "user" | "feedback" | "project" | "reference";

/** All valid memory types as a readonly tuple. */
export const ALL_MEMORY_TYPES: readonly MemoryType[] = [
  "user",
  "feedback",
  "project",
  "reference",
] as const;

/** Type guard — returns true if the value is a valid MemoryType. */
export function isMemoryType(value: unknown): value is MemoryType {
  return (
    typeof value === "string" &&
    (value === "user" || value === "feedback" || value === "project" || value === "reference")
  );
}

// ---------------------------------------------------------------------------
// Memory record — a single memory fact
// ---------------------------------------------------------------------------

/** YAML frontmatter fields for a memory file. */
export interface MemoryFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
}

/** A complete memory record with frontmatter + content. */
export interface MemoryRecord {
  readonly id: MemoryRecordId;
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly content: string;
  readonly filePath: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Input shape for creating a new memory record. */
export interface MemoryRecordInput {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly content: string;
}

/** Sparse update shape for modifying a memory record. */
export interface MemoryRecordPatch {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly type?: MemoryType | undefined;
  readonly content?: string | undefined;
}

// ---------------------------------------------------------------------------
// Memory index — the MEMORY.md model
// ---------------------------------------------------------------------------

/** Maximum number of lines in MEMORY.md before truncation. */
export const MEMORY_INDEX_MAX_LINES = 200;

/** A single entry in the MEMORY.md index. */
export interface MemoryIndexEntry {
  readonly title: string;
  readonly filePath: string;
  readonly hook: string;
}

/** The MEMORY.md index — always loaded into conversation context. */
export interface MemoryIndex {
  readonly entries: readonly MemoryIndexEntry[];
}

// ---------------------------------------------------------------------------
// Frontmatter field sanitization
// ---------------------------------------------------------------------------

/** Control character pattern (C0/C1 except tab) — global for .replace(). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — we need to match and strip control chars
const CONTROL_CHAR_REPLACE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** Control character pattern (C0/C1 except tab) — non-global for .test(). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — we need to detect control chars
const CONTROL_CHAR_TEST_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

/**
 * Sanitizes a frontmatter field value for safe YAML-like serialization.
 *
 * - Replaces newlines (LF, CR, CRLF) with spaces to prevent line injection
 * - Strips control characters (except tab, which is harmless)
 * - Collapses resulting whitespace runs
 * - Trims leading/trailing whitespace
 */
function sanitizeFrontmatterValue(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replace(CONTROL_CHAR_REPLACE_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Returns true if the value contains characters unsafe for frontmatter fields:
 * newlines or control characters.
 */
export function hasFrontmatterUnsafeChars(value: string): boolean {
  return /[\r\n]/.test(value) || CONTROL_CHAR_TEST_RE.test(value);
}

// ---------------------------------------------------------------------------
// Frontmatter parsing and serialization
// ---------------------------------------------------------------------------

/**
 * Parses frontmatter fields with strict validation.
 * Returns undefined if any field is missing, duplicated, unknown, or malformed.
 */
function parseFrontmatterFields(yamlBlock: string): MemoryFrontmatter | undefined {
  const fields = new Map<string, string>();
  for (const line of yamlBlock.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) continue;

    const colonIndex = trimmedLine.indexOf(":");
    if (colonIndex === -1) return undefined;

    const key = trimmedLine.slice(0, colonIndex).trim();
    if (key !== "name" && key !== "description" && key !== "type") return undefined;
    if (fields.has(key)) return undefined;

    const value = trimmedLine.slice(colonIndex + 1).trim();
    fields.set(key, value);
  }

  const name = fields.get("name");
  const description = fields.get("description");
  const type = fields.get("type");

  if (!name || !description || !type) return undefined;
  if (!isMemoryType(type)) return undefined;

  return { name, description, type };
}

/**
 * Parses YAML frontmatter from a memory Markdown file.
 *
 * Expects format:
 * ```markdown
 * ---
 * name: {{name}}
 * description: {{description}}
 * type: {{type}}
 * ---
 * {{content}}
 * ```
 *
 * Returns undefined if the frontmatter is missing or malformed.
 * Rejects empty/whitespace-only bodies (truncated writes).
 * Preserves leading blank lines in content during roundtrips.
 */
export function parseMemoryFrontmatter(
  raw: string,
): { readonly frontmatter: MemoryFrontmatter; readonly content: string } | undefined {
  const trimmed = raw.trimStart();

  // Require opener to be exactly "---" followed by newline (reject "----", "---x", etc.)
  if (!trimmed.startsWith("---\n") && !trimmed.startsWith("---\r\n")) return undefined;

  const afterOpener = trimmed.indexOf("\n", 3);
  if (afterOpener === -1) return undefined;

  const rest = trimmed.slice(afterOpener + 1);

  // Match closing delimiter: exactly "---" at start of line, followed by newline.
  // Only allows horizontal whitespace (spaces/tabs) after dashes, not \n,
  // to avoid consuming blank lines that belong to content.
  const closeMatch = rest.match(/^---[ \t]*\n/m);
  if (!closeMatch || closeMatch.index === undefined) {
    // Handle "---" at the very end of the string (no trailing newline) — empty body
    const eofMatch = rest.match(/^---[ \t]*$/m);
    if (!eofMatch || eofMatch.index === undefined) return undefined;
    // No content after closing delimiter → rejected by empty body check
    return undefined;
  }

  const yamlBlock = rest.slice(0, closeMatch.index).trim();

  // The serializer emits "---\n\n<content>" — the close regex consumed "---\n",
  // so afterClose starts with "\n<content>". Strip exactly that one separator
  // newline to preserve any leading blank lines in the actual content.
  const afterClose = rest.slice(closeMatch.index + closeMatch[0].length);
  const content = afterClose.replace(/^\n/, "");

  const frontmatter = parseFrontmatterFields(yamlBlock);
  if (!frontmatter) return undefined;

  // Reject empty/whitespace-only bodies — a truncated write should not
  // deserialize as a valid record
  if (content.trim().length === 0) return undefined;

  return { frontmatter, content };
}

/**
 * Serializes a MemoryFrontmatter + content into a Markdown file string.
 *
 * All field values are validated and sanitized: newlines are replaced with
 * spaces and control characters are stripped to prevent frontmatter injection.
 * The `type` field is validated at runtime (not just via TypeScript types)
 * to reject injected values from untyped JavaScript callers.
 *
 * Returns undefined if `type` is not a valid MemoryType at runtime.
 */
export function serializeMemoryFrontmatter(
  frontmatter: MemoryFrontmatter,
  content: string,
): string | undefined {
  // Runtime validation — TypeScript types are not enforced in JS callers
  if (!isMemoryType(frontmatter.type)) return undefined;

  const name = sanitizeFrontmatterValue(frontmatter.name);
  const description = sanitizeFrontmatterValue(frontmatter.description);

  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `type: ${frontmatter.type}`,
    "---",
    "",
    content,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validation error for memory records. */
export interface MemoryValidationError {
  readonly field: string;
  readonly message: string;
}

/**
 * Validates a MemoryRecordInput, returning an array of validation errors.
 * An empty array means the input is valid.
 */
export function validateMemoryRecordInput(
  input: Readonly<Record<string, unknown>>,
): readonly MemoryValidationError[] {
  const errors: MemoryValidationError[] = [];

  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    errors.push({ field: "name", message: "name is required and must be a non-empty string" });
  }

  if (typeof input.description !== "string" || input.description.trim().length === 0) {
    errors.push({
      field: "description",
      message: "description is required and must be a non-empty string",
    });
  }

  if (!isMemoryType(input.type)) {
    errors.push({
      field: "type",
      message: `type must be one of: ${ALL_MEMORY_TYPES.join(", ")}`,
    });
  }

  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    errors.push({
      field: "content",
      message: "content is required and must be a non-empty string",
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Index entry formatting
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Index file path validation
// ---------------------------------------------------------------------------

/**
 * Validates that a file path is safe for use in MEMORY.md index entries.
 *
 * Requirements:
 * - Must be a relative path (no leading `/` or drive letters like `C:`)
 * - Must not contain `..` path traversal segments
 * - Must end with `.md` extension
 * - Must not be empty
 *
 * Returns undefined if valid, or an error message string if invalid.
 */
export function validateMemoryFilePath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/").trim();
  if (normalized.length === 0) return "file path must not be empty";
  if (normalized.startsWith("/")) return "file path must be relative, not absolute";
  if (/^[a-zA-Z]:/.test(normalized)) return "file path must not contain drive letters";
  if (normalized.split("/").some((seg) => seg === ".."))
    return "file path must not contain '..' traversal";
  if (!normalized.endsWith(".md")) return "file path must end with .md extension";
  return undefined;
}

// ---------------------------------------------------------------------------
// Index entry escaping
// ---------------------------------------------------------------------------

/**
 * Sanitizes an index entry field: strips newlines and control characters
 * to guarantee each entry serializes to exactly one line.
 */
function sanitizeIndexValue(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replace(CONTROL_CHAR_REPLACE_RE, "")
    .trim();
}

/** Escapes Markdown link metacharacters in a title (brackets). */
function escapeTitle(value: string): string {
  return value.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** Unescapes Markdown link metacharacters in a title. */
function unescapeTitle(value: string): string {
  return value.replace(/\\\[/g, "[").replace(/\\\]/g, "]");
}

/**
 * Normalizes a file path to POSIX format (forward slashes only).
 *
 * Memory file paths are always project-relative and stored in POSIX format.
 * Backslashes from Windows-style paths are converted to forward slashes.
 */
function normalizeFilePath(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Escapes a file path for safe use in Markdown link destinations.
 *
 * Backslashes are normalized to forward slashes first (POSIX-only invariant).
 * Encoding is reversible: literal `%` is escaped to `%25` first,
 * then `(` and `)` are encoded to `%28` and `%29`. This ensures
 * paths already containing `%28` or `%29` roundtrip correctly.
 */
function escapeFilePath(value: string): string {
  return normalizeFilePath(value).replace(/%/g, "%25").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/**
 * Unescapes a percent-encoded file path from a Markdown link destination.
 *
 * Decodes in reverse order: `%28`/`%29` → `(`/`)`, then `%25` → `%`.
 */
function unescapeFilePath(value: string): string {
  return value.replace(/%28/g, "(").replace(/%29/g, ")").replace(/%25/g, "%");
}

/**
 * Formats a MemoryIndexEntry as a single Markdown line for MEMORY.md.
 *
 * Output: `- [Title](file.md) — one-line hook`
 *
 * All fields are sanitized (newlines/control chars stripped) to guarantee
 * exactly one output line. Title brackets and path parentheses/percents
 * are escaped for roundtrip fidelity with `parseMemoryIndexEntry`.
 *
 * File paths are validated: must be relative, no `..` traversal, `.md` extension.
 * Returns undefined if the file path is invalid.
 */
export function formatMemoryIndexEntry(entry: MemoryIndexEntry): string | undefined {
  const sanitizedPath = sanitizeIndexValue(entry.filePath);
  const pathError = validateMemoryFilePath(sanitizedPath);
  if (pathError !== undefined) return undefined;

  const title = escapeTitle(sanitizeIndexValue(entry.title));
  const filePath = escapeFilePath(sanitizedPath);
  const hook = sanitizeIndexValue(entry.hook);
  return `- [${title}](${filePath}) — ${hook}`;
}

/**
 * Parses a single MEMORY.md index line into a MemoryIndexEntry.
 *
 * Expected format: `- [Title](file.md) — one-line hook`
 * Handles escaped brackets in titles and percent-encoded chars in paths.
 * Validates that the parsed file path is safe (relative, no traversal, .md).
 * Returns undefined if the line doesn't match or the path is invalid.
 */
export function parseMemoryIndexEntry(line: string): MemoryIndexEntry | undefined {
  // Match with support for escaped brackets in title and percent-encoded chars in path
  const match = line.match(/^- \[((?:[^\]\\]|\\.)+)\]\(((?:[^)\\]|%[0-9a-fA-F]{2})+)\) — (.+)$/);
  if (!match) return undefined;
  const [, rawTitle, rawFilePath, hook] = match;
  if (!rawTitle || !rawFilePath || !hook) return undefined;

  const filePath = unescapeFilePath(rawFilePath);
  if (validateMemoryFilePath(filePath) !== undefined) return undefined;

  return {
    title: unescapeTitle(rawTitle),
    filePath,
    hook,
  };
}
