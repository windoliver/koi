/**
 * Default ACP fs/* method handlers.
 *
 * Koi provides file system access to the agent process using Bun's native
 * file APIs. These are the "headless IDE" handlers for fs/* callbacks.
 */

import type {
  FsReadTextFileParams,
  FsReadTextFileResult,
  FsWriteTextFileParams,
} from "./acp-schema.js";

// ---------------------------------------------------------------------------
// fs/read_text_file
// ---------------------------------------------------------------------------

/**
 * Handle an agent's fs/read_text_file request.
 *
 * Reads a text file using Bun.file(). Supports optional `line` and `limit`
 * parameters for reading a sub-range (1-based line numbers per ACP spec).
 */
export async function handleReadTextFile(
  params: FsReadTextFileParams,
): Promise<FsReadTextFileResult> {
  const file = Bun.file(params.path);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`File not found: ${params.path}`);
  }

  const text = await file.text();

  if (params.line === undefined && params.limit === undefined) {
    return { content: text };
  }

  // Apply line-range filtering (1-based per ACP spec)
  const lines = text.split("\n");
  const startLine = params.line !== undefined ? params.line - 1 : 0;
  const endLine = params.limit !== undefined ? startLine + params.limit : lines.length;

  const slice = lines.slice(Math.max(0, startLine), Math.min(lines.length, endLine));
  return { content: slice.join("\n") };
}

// ---------------------------------------------------------------------------
// fs/write_text_file
// ---------------------------------------------------------------------------

/**
 * Handle an agent's fs/write_text_file request.
 *
 * Writes text to a file using Bun.write().
 */
export async function handleWriteTextFile(params: FsWriteTextFileParams): Promise<null> {
  await Bun.write(params.path, params.content);
  return null;
}
