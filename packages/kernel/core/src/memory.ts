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
// Frontmatter parsing and serialization
// ---------------------------------------------------------------------------

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
 */
export function parseMemoryFrontmatter(
  raw: string,
): { readonly frontmatter: MemoryFrontmatter; readonly content: string } | undefined {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) return undefined;

  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) return undefined;

  const yamlBlock = trimmed.slice(3, endIndex).trim();
  const content = trimmed.slice(endIndex + 3).replace(/^\n/, "");

  const fields = new Map<string, string>();
  for (const line of yamlBlock.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    fields.set(key, value);
  }

  const name = fields.get("name");
  const description = fields.get("description");
  const type = fields.get("type");

  if (!name || !description || !type) return undefined;
  if (!isMemoryType(type)) return undefined;

  return {
    frontmatter: { name, description, type },
    content,
  };
}

/**
 * Serializes a MemoryFrontmatter + content into a Markdown file string.
 */
export function serializeMemoryFrontmatter(
  frontmatter: MemoryFrontmatter,
  content: string,
): string {
  return [
    "---",
    `name: ${frontmatter.name}`,
    `description: ${frontmatter.description}`,
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

/**
 * Formats a MemoryIndexEntry as a single Markdown line for MEMORY.md.
 *
 * Output: `- [Title](file.md) — one-line hook`
 */
export function formatMemoryIndexEntry(entry: MemoryIndexEntry): string {
  return `- [${entry.title}](${entry.filePath}) — ${entry.hook}`;
}

/**
 * Parses a single MEMORY.md index line into a MemoryIndexEntry.
 *
 * Expected format: `- [Title](file.md) — one-line hook`
 * Returns undefined if the line doesn't match the expected format.
 */
export function parseMemoryIndexEntry(line: string): MemoryIndexEntry | undefined {
  const match = line.match(/^- \[([^\]]+)\]\(([^)]+)\) — (.+)$/);
  if (!match) return undefined;
  const [, title, filePath, hook] = match;
  if (!title || !filePath || !hook) return undefined;
  return { title, filePath, hook };
}
