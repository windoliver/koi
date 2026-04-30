/**
 * Filesystem-backed AtifDocumentDelegate.
 * Stores append-optimized ATIF data as small metadata files plus step chunks.
 * Legacy `{dir}/{encodedDocId}.atif.json` documents are still readable and are
 * migrated to chunked storage on the next append.
 */

import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type AtifDocumentAppendBatch,
  type AtifDocumentAppendState,
  type AtifDocumentDelegate,
  createAtifAppendStateFromDocument,
} from "./atif-store.js";
import type { AtifDocument, AtifStep } from "./atif-types.js";
import {
  docIdToFilename,
  docIdToMetadataFilename,
  docIdToStepChunkFilename,
  filenameToDocId,
  metadataFilenameToDocId,
  stepChunkFilenameToInfo,
} from "./path-encoding.js";

/**
 * Creates a filesystem delegate that persists ATIF documents as chunked JSON files.
 * Auto-creates the directory on first write if it doesn't exist.
 */
export function createFsAtifDelegate(dir: string): AtifDocumentDelegate {
  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  function docPath(docId: string): string {
    return join(dir, docIdToFilename(docId));
  }

  function metadataPath(docId: string): string {
    return join(dir, docIdToMetadataFilename(docId));
  }

  function stepChunkPath(docId: string, startIndex: number): string {
    return join(dir, docIdToStepChunkFilename(docId, startIndex));
  }

  async function readMetadata(docId: string): Promise<AtifDocumentAppendState | undefined> {
    const file = Bun.file(metadataPath(docId));
    if (!(await file.exists())) return undefined;
    return (await file.json()) as AtifDocumentAppendState;
  }

  async function readStepChunks(docId: string): Promise<readonly AtifStep[]> {
    const entries = await listDirEntries();
    const chunks = entries
      .map((filename) => ({ filename, info: stepChunkFilenameToInfo(filename) }))
      .filter(
        (entry): entry is { filename: string; info: { docId: string; startIndex: number } } =>
          entry.info !== undefined && entry.info.docId === docId,
      )
      .sort((a, b) => a.info.startIndex - b.info.startIndex);

    const steps: AtifStep[] = [];
    for (const chunk of chunks) {
      const file = Bun.file(join(dir, chunk.filename));
      const chunkSteps = (await file.json()) as readonly AtifStep[];
      steps.push(...chunkSteps);
    }
    return steps;
  }

  async function writeChunkedDocument(docId: string, doc: AtifDocument): Promise<void> {
    await ensureDir();
    await deleteStepChunks(docId);
    const state = createAtifAppendStateFromDocument(doc);
    const firstStep = doc.steps[0];
    if (firstStep !== undefined) {
      await Bun.write(stepChunkPath(docId, firstStep.step_id), JSON.stringify(doc.steps));
    }
    await Bun.write(metadataPath(docId), JSON.stringify(state, null, 2));
    await unlinkIfExists(docPath(docId));
  }

  async function listDirEntries(): Promise<readonly string[]> {
    try {
      return await readdir(dir);
    } catch (err) {
      if (isNotFoundError(err)) return [];
      throw err;
    }
  }

  async function deleteStepChunks(docId: string): Promise<number> {
    const entries = await listDirEntries();
    let deleted = 0;
    for (const entry of entries) {
      const info = stepChunkFilenameToInfo(entry);
      if (info?.docId !== docId) continue;
      if (await unlinkIfExists(join(dir, entry))) deleted += 1;
    }
    return deleted;
  }

  return {
    async read(docId: string): Promise<AtifDocument | undefined> {
      const metadata = await readMetadata(docId);
      if (metadata !== undefined) {
        return { ...metadata.document, steps: await readStepChunks(docId) };
      }

      const file = Bun.file(docPath(docId));
      if (!(await file.exists())) return undefined;
      return (await file.json()) as AtifDocument;
    },

    async write(docId: string, doc: AtifDocument): Promise<void> {
      await writeChunkedDocument(docId, doc);
    },

    async list(): Promise<readonly string[]> {
      await ensureDir();
      const entries = await readdir(dir);
      const ids = new Set<string>();
      for (const e of entries) {
        const id = metadataFilenameToDocId(e) ?? filenameToDocId(e);
        if (id !== undefined) ids.add(id);
      }
      return [...ids];
    },

    async delete(docId: string): Promise<boolean> {
      const deletedChunks = await deleteStepChunks(docId);
      const deletedMetadata = await unlinkIfExists(metadataPath(docId));
      const deletedLegacy = await unlinkIfExists(docPath(docId));
      return deletedChunks > 0 || deletedMetadata || deletedLegacy;
    },

    async readAppendState(docId: string): Promise<AtifDocumentAppendState | undefined> {
      const metadata = await readMetadata(docId);
      if (metadata !== undefined) return metadata;

      const file = Bun.file(docPath(docId));
      if (!(await file.exists())) return undefined;

      const legacyDoc = (await file.json()) as AtifDocument;
      await writeChunkedDocument(docId, legacyDoc);
      return createAtifAppendStateFromDocument(legacyDoc);
    },

    async appendSteps(docId: string, batch: AtifDocumentAppendBatch): Promise<void> {
      await ensureDir();
      if (batch.steps.length > 0) {
        await Bun.write(stepChunkPath(docId, batch.startIndex), JSON.stringify(batch.steps));
      }
      const { startIndex: _startIndex, steps: _steps, ...state } = batch;
      await Bun.write(metadataPath(docId), JSON.stringify(state, null, 2));
      await unlinkIfExists(docPath(docId));
    },
  };
}

async function unlinkIfExists(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
