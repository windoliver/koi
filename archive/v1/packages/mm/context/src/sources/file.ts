/**
 * File source resolver — reads file content from disk.
 * When maxTokens is set, reads only the needed bytes via Bun.file().slice().
 */

import { mapFsError } from "@koi/errors";
import { CHARS_PER_TOKEN } from "@koi/token-estimator";
import type { FileSource, SourceResult } from "../types.js";

/** Resolves a file source by reading from the filesystem. */
export async function resolveFileSource(source: FileSource): Promise<SourceResult> {
  try {
    const file = Bun.file(source.path);
    const content =
      source.maxTokens !== undefined
        ? await file.slice(0, source.maxTokens * CHARS_PER_TOKEN).text()
        : await file.text();

    return {
      label: source.label ?? source.path,
      content,
      tokens: 0,
      source,
    };
  } catch (e: unknown) {
    const koiError = mapFsError(e, source.path);
    throw koiError;
  }
}
