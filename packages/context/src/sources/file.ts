/**
 * File source resolver — reads file content from disk.
 */

import type { FileSource, SourceResult } from "../types.js";

/** Resolves a file source by reading from the filesystem. */
export async function resolveFileSource(source: FileSource): Promise<SourceResult> {
  const content = await Bun.file(source.path).text();
  return {
    label: source.label ?? source.path,
    content,
    tokens: 0,
    source,
  };
}
