/**
 * Filesystem-backed AtifDocumentDelegate.
 * Stores each ATIF document as `{dir}/{encodedDocId}.atif.json`.
 *
 * Uses percent-encoding for the filename so the mapping is injective —
 * different docIds always produce different filenames.
 */

import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AtifDocumentDelegate } from "./atif-store.js";
import type { AtifDocument } from "./atif-types.js";

const EXTENSION = ".atif.json";

/**
 * Encode a docId for use as a filename using encodeURIComponent.
 * Handles all Unicode (emoji, CJK, etc.) correctly.
 * Additionally encodes dots to prevent hidden files on Unix.
 */
function encodeDocId(docId: string): string {
  return encodeURIComponent(docId).replace(/\./g, "%2E");
}

/** Decode a filename back to the original docId. */
function decodeDocId(encoded: string): string {
  return decodeURIComponent(encoded);
}

/**
 * Creates a filesystem delegate that persists ATIF documents as JSON files.
 * Auto-creates the directory on first write if it doesn't exist.
 */
export function createFsAtifDelegate(dir: string): AtifDocumentDelegate {
  // let: tracks whether we've ensured the directory exists
  let dirCreated = false;

  async function ensureDir(): Promise<void> {
    if (dirCreated) return;
    await mkdir(dir, { recursive: true });
    dirCreated = true;
  }

  function docPath(docId: string): string {
    return join(dir, `${encodeDocId(docId)}${EXTENSION}`);
  }

  return {
    async read(docId: string): Promise<AtifDocument | undefined> {
      const file = Bun.file(docPath(docId));
      if (!(await file.exists())) return undefined;
      return (await file.json()) as AtifDocument;
    },

    async write(docId: string, doc: AtifDocument): Promise<void> {
      await ensureDir();
      await Bun.write(docPath(docId), JSON.stringify(doc, null, 2));
    },

    async list(): Promise<readonly string[]> {
      await ensureDir();
      const entries = await readdir(dir);
      return entries
        .filter((e) => e.endsWith(EXTENSION))
        .map((e) => decodeDocId(e.slice(0, -EXTENSION.length)));
    },

    async delete(docId: string): Promise<boolean> {
      const path = docPath(docId);
      const file = Bun.file(path);
      if (!(await file.exists())) return false;
      await unlink(path);
      return true;
    },
  };
}
