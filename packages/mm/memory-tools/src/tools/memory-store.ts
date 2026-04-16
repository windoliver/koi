/**
 * memory_store tool — write or update a memory record with dedup check.
 *
 * Before creating a new record, checks for existing records with the same
 * name and type. If a duplicate exists and force is not true, returns a
 * dedup warning. If force is true, updates the existing record.
 */

import type { JsonObject, KoiError, MemoryRecordInput, Result, Tool } from "@koi/core";
import { ALL_MEMORY_TYPES, validateMemoryRecordInput } from "@koi/core";
import { buildTool } from "@koi/tools-core";
import { DEFAULT_PREFIX, validateMemoryDir } from "../constants.js";
import { parseOptionalBoolean, parseOptionalEnum, parseString } from "../parse-args.js";
import { safeBackendError, safeCatchError } from "../safe-error.js";
import type { MemoryToolBackend } from "../types.js";

/**
 * Canonicalize a frontmatter field value — same normalization as the
 * core serializer (`sanitizeFrontmatterValue`) so dedup lookup matches
 * the persisted form. Replaces newlines, strips C0/C1 control chars
 * (except tab), collapses whitespace, and trims.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strip control chars matching core serializer
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

function canonicalize(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replace(CONTROL_CHAR_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Parse and validate tool args into a MemoryRecordInput + force flag. */
function parseStoreArgs(
  args: JsonObject,
): { readonly input: MemoryRecordInput; readonly force: boolean } | { readonly error: unknown } {
  const nameResult = parseString(args, "name");
  if (!nameResult.ok) return { error: nameResult.err };

  const descResult = parseString(args, "description");
  if (!descResult.ok) return { error: descResult.err };

  const typeResult = parseOptionalEnum(args, "type", ALL_MEMORY_TYPES);
  if (!typeResult.ok) return { error: typeResult.err };
  if (typeResult.value === undefined) {
    return {
      error: {
        error: "type must be one of: user, feedback, project, reference",
        code: "VALIDATION",
      },
    };
  }

  const contentResult = parseString(args, "content");
  if (!contentResult.ok) return { error: contentResult.err };

  const forceResult = parseOptionalBoolean(args, "force");
  if (!forceResult.ok) return { error: forceResult.err };

  const input = {
    name: canonicalize(nameResult.value),
    description: canonicalize(descResult.value),
    type: typeResult.value,
    content: contentResult.value,
  };
  const validationErrors = validateMemoryRecordInput(input);
  if (validationErrors.length > 0) {
    return {
      error: {
        error: validationErrors.map((e) => `${e.field}: ${e.message}`).join("; "),
        code: "VALIDATION",
      },
    };
  }

  return { input, force: forceResult.value === true };
}

/**
 * Execute handler — delegates to the backend's atomic storeWithDedup.
 *
 * No check-then-act race: uniqueness is enforced by the backend in a single
 * atomic operation. See MemoryToolBackend.storeWithDedup contract.
 */
async function executeStore(args: JsonObject, backend: MemoryToolBackend): Promise<unknown> {
  const parsed = parseStoreArgs(args);
  if ("error" in parsed) return parsed.error;

  const { input, force } = parsed;

  try {
    const result = await backend.storeWithDedup(input, { force });
    if (!result.ok) return safeBackendError(result.error, "Failed to store memory");

    const { value } = result;
    switch (value.action) {
      case "created":
        return { stored: true, id: value.record.id };
      case "updated":
        return { stored: true, id: value.record.id, updated: true };
      case "conflict": {
        // Retry-safe: if the existing record has the exact same content and
        // description, treat it as a successful replay (caller's prior write
        // succeeded but the response was lost). Only surface a conflict when
        // the payloads actually differ.
        const exact =
          value.existing.content === input.content &&
          value.existing.description === input.description;
        if (exact) {
          return { stored: true, id: value.existing.id, replayed: true };
        }
        return {
          stored: false,
          duplicate: { id: value.existing.id, name: value.existing.name },
          message: "A memory with this name and type already exists. Use force: true to overwrite.",
        };
      }
    }
  } catch {
    return safeCatchError("Failed to store memory");
  }
}

/** Create the memory_store tool. */
export function createMemoryStoreTool(
  backend: MemoryToolBackend,
  memoryDir: string,
  prefix: string = DEFAULT_PREFIX,
): Result<Tool, KoiError> {
  const dirValidation = validateMemoryDir(memoryDir);
  if (!dirValidation.ok) return dirValidation;

  return buildTool({
    name: `${prefix}_store`,
    description:
      "Store a new memory record. Checks for duplicates by name and type. " +
      "Use force: true to overwrite an existing memory with the same name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable name for the memory" },
        description: {
          type: "string",
          description: "One-line description used to decide relevance in future conversations",
        },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description: "Memory category",
        },
        content: { type: "string", description: "The memory content body" },
        force: {
          type: "boolean",
          description: "Skip dedup check and overwrite existing memory if found",
        },
      },
      required: ["name", "description", "type", "content"],
    },
    origin: "primordial",
    sandbox: true,
    // NOTE: buildTool unions these with DEFAULT_SANDBOXED_POLICY defaults
    // (read: /usr,/bin,/lib,/etc,/tmp; write: /tmp/koi-sandbox-*). A future
    // buildTool "replace" mode will restrict to memoryDir only. The backend
    // is already scoped to its configured directory — these caps declare
    // intent, not sole access.
    filesystem: { read: [memoryDir], write: [memoryDir] },
    execute: async (args: JsonObject): Promise<unknown> => executeStore(args, backend),
  });
}
