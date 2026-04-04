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
import { DEFAULT_PREFIX } from "../constants.js";
import { parseOptionalBoolean, parseOptionalEnum, parseString } from "../parse-args.js";
import { safeBackendError, safeCatchError } from "../safe-error.js";
import type { MemoryToolBackend } from "../types.js";

/**
 * Canonicalize a frontmatter field value — same normalization as the
 * core serializer so dedup lookup matches the persisted form.
 */
function canonicalize(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, " ")
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
 * Execute handler — performs dedup check and store/update.
 *
 * NOTE: The dedup check is best-effort (check-then-act). Concurrent calls
 * with the same name/type can both pass the check. True uniqueness must be
 * enforced by the backend's store() method (e.g. unique constraint).
 */
async function executeStore(args: JsonObject, backend: MemoryToolBackend): Promise<unknown> {
  const parsed = parseStoreArgs(args);
  if ("error" in parsed) return parsed.error;

  const { input, force } = parsed;

  try {
    const dupResult = await backend.findByName(input.name, input.type);
    if (!dupResult.ok) return safeBackendError(dupResult.error, "Failed to check for duplicates");

    if (dupResult.value !== undefined) {
      if (!force) {
        return {
          stored: false,
          duplicate: { id: dupResult.value.id, name: dupResult.value.name },
          message: "A memory with this name and type already exists. Use force: true to overwrite.",
        };
      }
      const updateResult = await backend.update(dupResult.value.id, {
        description: input.description,
        content: input.content,
      });
      if (!updateResult.ok) return safeBackendError(updateResult.error, "Failed to update memory");
      return { stored: true, id: updateResult.value.id, updated: true };
    }

    const storeResult = await backend.store(input);
    if (!storeResult.ok) return safeBackendError(storeResult.error, "Failed to store memory");
    return { stored: true, id: storeResult.value.id, filePath: storeResult.value.filePath };
  } catch {
    return safeCatchError("Failed to store memory");
  }
}

/** Create the memory_store tool. */
export function createMemoryStoreTool(
  backend: MemoryToolBackend,
  prefix: string = DEFAULT_PREFIX,
): Result<Tool, KoiError> {
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
    sandbox: false,
    execute: async (args: JsonObject): Promise<unknown> => executeStore(args, backend),
  });
}
