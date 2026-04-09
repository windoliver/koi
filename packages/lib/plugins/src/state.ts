/**
 * Persists the set of disabled plugin names to `<userRoot>/state.json`.
 * Default: all plugins enabled. Only disabled names are stored.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const pluginStateSchema = z.object({
  disabled: z.array(z.string()).readonly(),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILE = "state.json";
const STATE_TMP_PREFIX = ".state.json.tmp.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads the disabled-plugin set from `<userRoot>/state.json`.
 * Returns an empty set when the file does not exist (first run).
 */
export async function readPluginState(
  userRoot: string,
): Promise<Result<ReadonlySet<string>, KoiError>> {
  const filePath = join(userRoot, STATE_FILE);

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return { ok: true, value: new Set<string>() };
    }
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Cannot read plugin state: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
        context: { filePath },
      },
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid plugin state JSON: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
        context: { filePath },
      },
    };
  }

  const validated = validateWith(pluginStateSchema, raw, "Plugin state validation failed");
  if (!validated.ok) {
    return validated;
  }

  return { ok: true, value: new Set(validated.value.disabled) };
}

/**
 * Atomically writes the disabled-plugin set to `<userRoot>/state.json`.
 * Uses write-to-tmp + rename to prevent corruption on crash.
 * Each write uses a unique temp file to avoid clobbering concurrent writers.
 */
export async function writePluginState(
  userRoot: string,
  disabled: ReadonlySet<string>,
): Promise<Result<void, KoiError>> {
  const filePath = join(userRoot, STATE_FILE);
  // Per-write unique temp file prevents concurrent writers from clobbering each other's temp
  const tmpPath = join(
    userRoot,
    `${STATE_TMP_PREFIX}${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
  );
  const payload = JSON.stringify({ disabled: [...disabled].sort() }, null, 2);

  try {
    await mkdir(userRoot, { recursive: true });
    await writeFile(tmpPath, payload, "utf-8");
    await rename(tmpPath, filePath);
  } catch (err: unknown) {
    // Best-effort cleanup of our unique temp file
    await rm(tmpPath, { force: true }).catch(() => {});
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Cannot write plugin state: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
        context: { filePath },
      },
    };
  }

  return { ok: true, value: undefined };
}
