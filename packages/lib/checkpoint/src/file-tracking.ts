/**
 * File operation tracking — extracts pre/post-image hashes around a tracked
 * tool call, builds the right `FileOpRecord` variant, and returns it.
 *
 * Called from `wrapToolCall` in the checkpoint middleware. The flow is:
 *
 *   1. Parse the file path from the tool's input args.
 *   2. Capture pre-image: does the file exist? If so, hash it into CAS.
 *   3. Run the tool (`await next(request)`).
 *   4. Capture post-image: does the file exist now? If so, hash it into CAS.
 *   5. Determine the op kind from (preExists, postExists, hashes).
 *   6. Return a `FileOpRecord` if anything actually changed; otherwise undefined.
 *
 * The "anything actually changed" check is important: tools that fail or
 * no-op (e.g. `dryRun: true`, edits with no matching old text) should not
 * pollute the snapshot with bogus records.
 */

import type { FileOpRecord, JsonObject, ToolCallId } from "@koi/core";
import { writeBlobFromFile } from "./cas-store.js";

interface PreImage {
  readonly existed: boolean;
  readonly contentHash: string | undefined;
}

interface PostImage {
  readonly existed: boolean;
  readonly contentHash: string | undefined;
}

/**
 * Extract the absolute file path from a tool input. Returns `undefined` if
 * the input doesn't have a usable path string. Both `fs_edit` and `fs_write`
 * use `path` as their argument key.
 */
export function extractPath(input: JsonObject): string | undefined {
  const value = input.path;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Capture the pre-image of a file: hash its current content into CAS if it
 * exists, otherwise note that it didn't exist. Best-effort — a hash failure
 * (e.g., permission denied) is treated as "file does not exist for our
 * purposes" rather than throwing, so the tool call still runs.
 */
export async function capturePreImage(blobDir: string, path: string): Promise<PreImage> {
  if (!(await Bun.file(path).exists())) {
    return { existed: false, contentHash: undefined };
  }
  try {
    const hash = await writeBlobFromFile(blobDir, path);
    return { existed: true, contentHash: hash };
  } catch {
    return { existed: false, contentHash: undefined };
  }
}

/**
 * Capture the post-image after a tool call. Same shape as `capturePreImage`.
 */
export async function capturePostImage(blobDir: string, path: string): Promise<PostImage> {
  if (!(await Bun.file(path).exists())) {
    return { existed: false, contentHash: undefined };
  }
  try {
    const hash = await writeBlobFromFile(blobDir, path);
    return { existed: true, contentHash: hash };
  } catch {
    return { existed: false, contentHash: undefined };
  }
}

interface BuildFileOpInput {
  readonly callId: ToolCallId;
  readonly path: string;
  readonly turnIndex: number;
  readonly eventIndex: number;
  readonly pre: PreImage;
  readonly post: PostImage;
  readonly backend?: string;
}

/**
 * Build the right `FileOpRecord` variant from a (pre, post) pair, or return
 * `undefined` if nothing actually changed.
 *
 * The four cases:
 *
 *   pre  post  →  result
 *   ───  ───      ──────
 *   no   no   →  undefined  (tool didn't create the file)
 *   no   yes  →  create     (file came into existence)
 *   yes  no   →  delete     (file was removed)
 *   yes  yes  →  edit       (only if the content hash changed)
 *                undefined  (no-op tool call, e.g. dry-run)
 */
export function buildFileOpRecord(input: BuildFileOpInput): FileOpRecord | undefined {
  const { callId, path, turnIndex, eventIndex, pre, post } = input;
  const timestamp = Date.now();
  const backendField = input.backend !== undefined ? { backend: input.backend } : {};

  if (!pre.existed && !post.existed) {
    return undefined;
  }

  if (!pre.existed && post.existed && post.contentHash !== undefined) {
    return {
      kind: "create",
      callId,
      path,
      postContentHash: post.contentHash,
      turnIndex,
      eventIndex,
      timestamp,
      ...backendField,
    };
  }

  if (pre.existed && !post.existed && pre.contentHash !== undefined) {
    return {
      kind: "delete",
      callId,
      path,
      preContentHash: pre.contentHash,
      turnIndex,
      eventIndex,
      timestamp,
      ...backendField,
    };
  }

  // Both exist — record an edit only if the content changed.
  if (
    pre.existed &&
    post.existed &&
    pre.contentHash !== undefined &&
    post.contentHash !== undefined &&
    pre.contentHash !== post.contentHash
  ) {
    return {
      kind: "edit",
      callId,
      path,
      preContentHash: pre.contentHash,
      postContentHash: post.contentHash,
      turnIndex,
      eventIndex,
      timestamp,
      ...backendField,
    };
  }

  return undefined;
}
