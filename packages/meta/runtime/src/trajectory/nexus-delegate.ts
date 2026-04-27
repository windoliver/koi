/**
 * Nexus-backed AtifDocumentDelegate.
 * Stores append-optimized ATIF data as metadata files plus step chunks on a Nexus server.
 * Legacy `{basePath}/{encodedDocId}.atif.json` documents are still readable and are
 * migrated to chunked storage on the next append.
 *
 * Ported from archive/v1/packages/fs/nexus-store/src/ace.ts (createNexusAtifDelegate).
 *
 * Design constraints (Phase 1):
 *   - **Single-writer per docId** — no OCC or server-side locking. The AtifDocumentStore
 *     serializes appends per-process via a per-docId mutex, but two processes writing to
 *     the same docId WILL lose updates (last-writer-wins). This is safe because docId =
 *     sessionId and sessions are single-process. Phase 2 should add OCC via etag/if_match
 *     if multi-writer is ever needed (#1469).
 *   - Rate-limit retry with exponential backoff on write
 *   - Only NOT_FOUND maps to undefined; auth/permission errors propagate
 */

import type { KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/fs-nexus";
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
  docIdToStepChunkGlob,
  filenameToDocId,
  metadataFilenameToDocId,
  stepChunkFilenameToInfo,
} from "./path-encoding.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusTrajectoryConfig {
  /** Nexus transport (from createHttpTransport or createLocalTransport). */
  readonly transport: NexusTransport;
  /** Nexus path prefix for trajectory documents. Default: "trajectories". */
  readonly basePath?: string | undefined;
}

const DEFAULT_BASE_PATH = "trajectories";
const WRITE_MAX_RETRIES = 4;
const WRITE_BACKOFF_BASE_MS = 2000;

// ---------------------------------------------------------------------------
// basePath validation
// ---------------------------------------------------------------------------

function validateBasePath(basePath: string): void {
  if (basePath === "") {
    throw new Error("trajectoryNexus.basePath must not be empty");
  }
  if (basePath.includes("..")) {
    throw new Error("trajectoryNexus.basePath must not contain '..' segments");
  }
  if (basePath.endsWith("/")) {
    throw new Error("trajectoryNexus.basePath must not end with '/'");
  }
}

// ---------------------------------------------------------------------------
// Nexus response decoding
// ---------------------------------------------------------------------------

/**
 * Decode a Nexus read response. Nexus may return:
 *   - A raw JSON string
 *   - A bytes envelope: { __type__: "bytes", data: "base64..." }
 *   - A structured envelope: { content: string, metadata?: ... }
 *   - An already-parsed object
 */
function decodeNexusResponse<T>(raw: unknown): T {
  if (typeof raw === "string") return JSON.parse(raw) as T;
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    // Bytes envelope (Nexus NFS binary response)
    if (obj.__type__ === "bytes" && typeof obj.data === "string") {
      const decoded = Buffer.from(obj.data, "base64").toString("utf-8");
      return JSON.parse(decoded) as T;
    }
    // Structured envelope { content: string, metadata? } from Nexus read
    if (typeof obj.content === "string" && !("schema_version" in obj)) {
      return JSON.parse(obj.content) as T;
    }
  }
  return raw as T;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Nexus-backed ATIF document delegate for trajectory persistence. */
export function createNexusAtifDelegate(config: NexusTrajectoryConfig): AtifDocumentDelegate {
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  validateBasePath(basePath);

  const { transport } = config;

  // Nexus NFS expects absolute paths with leading slash
  const normalizedBase = basePath.startsWith("/") ? basePath : `/${basePath}`;

  function docPath(docId: string): string {
    return `${normalizedBase}/${docIdToFilename(docId)}`;
  }

  function metadataPath(docId: string): string {
    return `${normalizedBase}/${docIdToMetadataFilename(docId)}`;
  }

  function stepChunkPath(docId: string, startIndex: number): string {
    return `${normalizedBase}/${docIdToStepChunkFilename(docId, startIndex)}`;
  }

  /** Throw a KoiError as an Error with the original attached as cause. */
  function throwKoiError(err: KoiError): never {
    throw new Error(err.message, { cause: err });
  }

  async function writeContent(path: string, content: string): Promise<void> {
    for (let attempt = 0; attempt <= WRITE_MAX_RETRIES; attempt++) {
      const result: Result<unknown, KoiError> = await transport.call("write", {
        path,
        content,
      });
      if (result.ok) return;

      const isRateLimit = result.error.code === "RATE_LIMIT";
      if (attempt < WRITE_MAX_RETRIES && isRateLimit) {
        // Exponential backoff: 2s, 4s, 8s, 16s
        await new Promise<void>((resolve) =>
          setTimeout(resolve, WRITE_BACKOFF_BASE_MS * 2 ** attempt),
        );
        continue;
      }
      throwKoiError(result.error);
    }
  }

  async function readMetadata(docId: string): Promise<AtifDocumentAppendState | undefined> {
    const result: Result<unknown, KoiError> = await transport.call("read", {
      path: metadataPath(docId),
    });
    if (!result.ok) {
      if (result.error.code === "NOT_FOUND") return undefined;
      throwKoiError(result.error);
    }
    const decoded = decodeNexusResponse<unknown>(result.value);
    return isAppendState(decoded) ? decoded : undefined;
  }

  async function readLegacyDocument(docId: string): Promise<AtifDocument | undefined> {
    const result: Result<unknown, KoiError> = await transport.call("read", {
      path: docPath(docId),
    });
    if (!result.ok) {
      if (result.error.code === "NOT_FOUND") return undefined;
      throwKoiError(result.error);
    }
    return decodeNexusResponse<AtifDocument>(result.value);
  }

  async function globPaths(pattern: string): Promise<readonly string[]> {
    const result: Result<unknown, KoiError> = await transport.call("glob", { pattern });
    if (!result.ok) {
      if (result.error.code === "NOT_FOUND") return [];
      throwKoiError(result.error);
    }

    const raw = result.value;
    return Array.isArray(raw)
      ? (raw as readonly string[])
      : typeof raw === "object" &&
          raw !== null &&
          "matches" in raw &&
          Array.isArray((raw as { matches: unknown }).matches)
        ? (raw as { matches: readonly string[] }).matches
        : [];
  }

  async function readStepChunks(docId: string): Promise<readonly AtifStep[]> {
    const prefix = `${normalizedBase}/`;
    const chunkPaths = await globPaths(`${normalizedBase}/${docIdToStepChunkGlob(docId)}`);
    const chunks = chunkPaths
      .map((path) => {
        const filename = path.startsWith(prefix)
          ? path.slice(prefix.length)
          : (path.split("/").pop() ?? "");
        return { path, info: stepChunkFilenameToInfo(filename) };
      })
      .filter(
        (entry): entry is { path: string; info: { docId: string; startIndex: number } } =>
          entry.info !== undefined && entry.info.docId === docId,
      )
      .sort((a, b) => a.info.startIndex - b.info.startIndex);

    const steps: AtifStep[] = [];
    for (const chunk of chunks) {
      const result: Result<unknown, KoiError> = await transport.call("read", { path: chunk.path });
      if (!result.ok) {
        if (result.error.code === "NOT_FOUND") continue;
        throwKoiError(result.error);
      }
      steps.push(...decodeNexusResponse<readonly AtifStep[]>(result.value));
    }
    return steps;
  }

  async function deletePath(path: string): Promise<boolean> {
    const result: Result<unknown, KoiError> = await transport.call("delete", { path });
    if (!result.ok) {
      if (result.error.code === "NOT_FOUND") return false;
      throwKoiError(result.error);
    }
    return true;
  }

  async function deleteStepChunks(docId: string): Promise<number> {
    const prefix = `${normalizedBase}/`;
    const chunkPaths = await globPaths(`${normalizedBase}/${docIdToStepChunkGlob(docId)}`);
    let deleted = 0;
    for (const path of chunkPaths) {
      const filename = path.startsWith(prefix)
        ? path.slice(prefix.length)
        : (path.split("/").pop() ?? "");
      const info = stepChunkFilenameToInfo(filename);
      if (info?.docId !== docId) continue;
      if (await deletePath(path)) deleted += 1;
    }
    return deleted;
  }

  async function writeChunkedDocument(docId: string, doc: AtifDocument): Promise<void> {
    await deleteStepChunks(docId);
    const state = createAtifAppendStateFromDocument(doc);
    const firstStep = doc.steps[0];
    if (firstStep !== undefined) {
      await writeContent(stepChunkPath(docId, firstStep.step_id), JSON.stringify(doc.steps));
    }
    await writeContent(metadataPath(docId), JSON.stringify(state));
    await deletePath(docPath(docId));
  }

  return {
    async read(docId: string): Promise<AtifDocument | undefined> {
      const metadata = await readMetadata(docId);
      if (metadata !== undefined) {
        return { ...metadata.document, steps: await readStepChunks(docId) };
      }
      return readLegacyDocument(docId);
    },

    async write(docId: string, doc: AtifDocument): Promise<void> {
      await writeChunkedDocument(docId, doc);
    },

    async list(): Promise<readonly string[]> {
      const paths = [
        ...(await globPaths(`${normalizedBase}/*.atif.meta.json`)),
        ...(await globPaths(`${normalizedBase}/*.atif.json`)),
      ];

      const ids = new Set<string>();
      for (const p of paths) {
        const fileName = p.split("/").pop() ?? "";
        const id = metadataFilenameToDocId(fileName) ?? filenameToDocId(fileName);
        if (id !== undefined) ids.add(id);
      }
      return [...ids];
    },

    async delete(docId: string): Promise<boolean> {
      const deletedChunks = await deleteStepChunks(docId);
      const deletedMetadata = await deletePath(metadataPath(docId));
      const deletedLegacy = await deletePath(docPath(docId));
      return deletedChunks > 0 || deletedMetadata || deletedLegacy;
    },

    async readAppendState(docId: string): Promise<AtifDocumentAppendState | undefined> {
      const metadata = await readMetadata(docId);
      if (metadata !== undefined) return metadata;

      const legacyDoc = await readLegacyDocument(docId);
      if (legacyDoc === undefined) return undefined;

      await writeChunkedDocument(docId, legacyDoc);
      return createAtifAppendStateFromDocument(legacyDoc);
    },

    async appendSteps(docId: string, batch: AtifDocumentAppendBatch): Promise<void> {
      if (batch.steps.length > 0) {
        await writeContent(stepChunkPath(docId, batch.startIndex), JSON.stringify(batch.steps));
      }
      const { startIndex: _startIndex, steps: _steps, ...state } = batch;
      await writeContent(metadataPath(docId), JSON.stringify(state));
      await deletePath(docPath(docId));
    },
  };
}

function isAppendState(value: unknown): value is AtifDocumentAppendState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AtifDocumentAppendState>;
  return (
    typeof candidate.document === "object" &&
    candidate.document !== null &&
    typeof candidate.stepCount === "number" &&
    typeof candidate.nextStepIndex === "number" &&
    typeof candidate.lastTimestampMs === "number" &&
    typeof candidate.sizeBytes === "number"
  );
}
