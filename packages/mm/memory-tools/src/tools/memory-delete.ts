/**
 * memory_delete tool — remove a stale or incorrect memory record.
 *
 * Verifies the record exists before attempting deletion.
 * The backend is responsible for removing the file and updating
 * the MEMORY.md index.
 */

import type { JsonObject, KoiError, Result, Tool } from "@koi/core";
import { memoryRecordId } from "@koi/core";
import { buildTool } from "@koi/tools-core";
import { DEFAULT_PREFIX } from "../constants.js";
import { parseString } from "../parse-args.js";
import { safeBackendError, safeCatchError } from "../safe-error.js";
import type { MemoryToolBackend } from "../types.js";

/** Execute handler — extracted for size limit. */
async function executeDelete(args: JsonObject, backend: MemoryToolBackend): Promise<unknown> {
  const idResult = parseString(args, "id");
  if (!idResult.ok) return idResult.err;

  const id = memoryRecordId(idResult.value);

  try {
    const getResult = await backend.get(id);
    if (!getResult.ok) return safeBackendError(getResult.error, "Failed to look up memory");
    if (getResult.value === undefined) {
      return { deleted: false, error: "Memory not found", code: "NOT_FOUND" };
    }

    const deleteResult = await backend.delete(id);
    if (!deleteResult.ok) return safeBackendError(deleteResult.error, "Failed to delete memory");
    return { deleted: true, id: idResult.value };
  } catch {
    return safeCatchError("Failed to delete memory");
  }
}

/** Create the memory_delete tool. */
export function createMemoryDeleteTool(
  backend: MemoryToolBackend,
  prefix: string = DEFAULT_PREFIX,
): Result<Tool, KoiError> {
  return buildTool({
    name: `${prefix}_delete`,
    description: "Delete a memory record by ID. Removes the file and updates the MEMORY.md index.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory record ID to delete" },
      },
      required: ["id"],
    },
    origin: "primordial",
    sandbox: false,
    execute: async (args: JsonObject): Promise<unknown> => executeDelete(args, backend),
  });
}
