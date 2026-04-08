/**
 * Filesystem-backed AtifDocumentDelegate.
 * Stores each ATIF document as `{dir}/{encodedDocId}.atif.json`.
 */

import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AtifDocumentDelegate } from "./atif-store.js";
import type { AtifDocument } from "./atif-types.js";
import { docIdToFilename, filenameToDocId } from "./path-encoding.js";

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
    return join(dir, docIdToFilename(docId));
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
      const ids: string[] = [];
      for (const e of entries) {
        const id = filenameToDocId(e);
        if (id !== undefined) ids.push(id);
      }
      return ids;
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
