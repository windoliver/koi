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
import { DEFAULT_PREFIX, validateMemoryDir } from "../constants.js";
import { parseString } from "../parse-args.js";
import { safeBackendError, safeCatchError } from "../safe-error.js";
import type { MemoryToolBackend } from "../types.js";

/**
 * Max length for memory record IDs — defense-in-depth against oversized inputs.
 * Generous limit since MemoryRecordId is unconstrained in core.
 */
const MAX_ID_LENGTH = 512;

/**
 * Execute handler — idempotent delete.
 *
 * Calls backend.delete directly — no get precheck. Already-absent records
 * are treated as successful completion (wasPresent: false), making retries safe.
 */
async function executeDelete(args: JsonObject, backend: MemoryToolBackend): Promise<unknown> {
  const idResult = parseString(args, "id");
  if (!idResult.ok) return idResult.err;

  if (idResult.value.length > MAX_ID_LENGTH) {
    return { error: "id exceeds maximum length", code: "VALIDATION" };
  }

  const id = memoryRecordId(idResult.value);

  try {
    const deleteResult = await backend.delete(id);
    if (!deleteResult.ok) return safeBackendError(deleteResult.error, "Failed to delete memory");
    // Idempotent: deleted is always true — the desired state (record absent)
    // is achieved regardless of whether it was present. wasPresent is
    // informational metadata for callers that need to distinguish.
    return {
      deleted: true,
      id: idResult.value,
      wasPresent: deleteResult.value.wasPresent,
    };
  } catch {
    return safeCatchError("Failed to delete memory");
  }
}

/** Create the memory_delete tool. */
export function createMemoryDeleteTool(
  backend: MemoryToolBackend,
  memoryDir: string,
  prefix: string = DEFAULT_PREFIX,
): Result<Tool, KoiError> {
  const dirValidation = validateMemoryDir(memoryDir);
  if (!dirValidation.ok) return dirValidation;

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
    sandbox: true,
    filesystem: { read: [memoryDir], write: [memoryDir] },
    execute: async (args: JsonObject): Promise<unknown> => executeDelete(args, backend),
  });
}
