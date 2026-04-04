/**
 * memory_store tool — write or update a memory record with dedup check.
 *
 * Before creating a new record, checks for existing records with the same
 * name and type. If a duplicate exists and force is not true, returns a
 * dedup warning. If force is true, updates the existing record.
 */

import type { JsonObject, KoiError, Result, Tool, ToolPolicy } from "@koi/core";
import { ALL_MEMORY_TYPES, DEFAULT_UNSANDBOXED_POLICY, validateMemoryRecordInput } from "@koi/core";
import { buildTool } from "@koi/tools-core";
import { DEFAULT_PREFIX } from "../constants.js";
import { parseOptionalBoolean, parseOptionalEnum, parseString } from "../parse-args.js";
import type { MemoryToolBackend } from "../types.js";

/** Execute handler — extracted for size limit. */
async function executeStore(args: JsonObject, backend: MemoryToolBackend): Promise<unknown> {
  const nameResult = parseString(args, "name");
  if (!nameResult.ok) return nameResult.err;

  const descResult = parseString(args, "description");
  if (!descResult.ok) return descResult.err;

  const typeResult = parseOptionalEnum(args, "type", ALL_MEMORY_TYPES);
  if (!typeResult.ok) return typeResult.err;
  if (typeResult.value === undefined) {
    return { error: "type must be one of: user, feedback, project, reference", code: "VALIDATION" };
  }

  const contentResult = parseString(args, "content");
  if (!contentResult.ok) return contentResult.err;

  const forceResult = parseOptionalBoolean(args, "force");
  if (!forceResult.ok) return forceResult.err;

  const input = {
    name: nameResult.value,
    description: descResult.value,
    type: typeResult.value,
    content: contentResult.value,
  };

  const validationErrors = validateMemoryRecordInput(input);
  if (validationErrors.length > 0) {
    return {
      error: validationErrors.map((e) => `${e.field}: ${e.message}`).join("; "),
      code: "VALIDATION",
    };
  }

  try {
    // Dedup check
    if (forceResult.value !== true) {
      const dupResult = await backend.findByName(input.name, input.type);
      if (!dupResult.ok) return { error: dupResult.error.message, code: "INTERNAL" };
      if (dupResult.value !== undefined) {
        return {
          stored: false,
          duplicate: { id: dupResult.value.id, name: dupResult.value.name },
          message: "A memory with this name and type already exists. Use force: true to overwrite.",
        };
      }
    }

    // Force update existing
    if (forceResult.value === true) {
      const dupResult = await backend.findByName(input.name, input.type);
      if (!dupResult.ok) return { error: dupResult.error.message, code: "INTERNAL" };
      if (dupResult.value !== undefined) {
        const updateResult = await backend.update(dupResult.value.id, {
          description: input.description,
          content: input.content,
        });
        if (!updateResult.ok) return { error: updateResult.error.message, code: "INTERNAL" };
        return { stored: true, id: updateResult.value.id, updated: true };
      }
    }

    // Create new
    const storeResult = await backend.store(input);
    if (!storeResult.ok) return { error: storeResult.error.message, code: "INTERNAL" };
    return { stored: true, id: storeResult.value.id, filePath: storeResult.value.filePath };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
  }
}

/** Create the memory_store tool. */
export function createMemoryStoreTool(
  backend: MemoryToolBackend,
  prefix: string = DEFAULT_PREFIX,
  _policy: ToolPolicy = DEFAULT_UNSANDBOXED_POLICY,
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
