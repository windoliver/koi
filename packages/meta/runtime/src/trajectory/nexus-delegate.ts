/**
 * Nexus-backed AtifDocumentDelegate.
 * Stores each ATIF document as `{basePath}/{encodedDocId}.atif.json` on a Nexus server.
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
import type { AtifDocumentDelegate } from "./atif-store.js";
import type { AtifDocument } from "./atif-types.js";
import { docIdToFilename, filenameToDocId } from "./path-encoding.js";

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

  /** Throw a KoiError as an Error with the original attached as cause. */
  function throwKoiError(err: KoiError): never {
    throw new Error(err.message, { cause: err });
  }

  return {
    async read(docId: string): Promise<AtifDocument | undefined> {
      const result: Result<unknown, KoiError> = await transport.call("read", {
        path: docPath(docId),
      });
      if (!result.ok) {
        if (result.error.code === "NOT_FOUND") return undefined;
        throwKoiError(result.error);
      }
      return decodeNexusResponse<AtifDocument>(result.value);
    },

    async write(docId: string, doc: AtifDocument): Promise<void> {
      const content = JSON.stringify(doc);
      const path = docPath(docId);

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
    },

    async list(): Promise<readonly string[]> {
      const result: Result<unknown, KoiError> = await transport.call("glob", {
        pattern: `${normalizedBase}/*.atif.json`,
      });
      if (!result.ok) {
        if (result.error.code === "NOT_FOUND") return [];
        throwKoiError(result.error);
      }

      const raw = result.value;
      const paths: readonly string[] = Array.isArray(raw)
        ? (raw as readonly string[])
        : typeof raw === "object" &&
            raw !== null &&
            "matches" in raw &&
            Array.isArray((raw as { matches: unknown }).matches)
          ? (raw as { matches: readonly string[] }).matches
          : [];

      const ids: string[] = [];
      for (const p of paths) {
        const fileName = p.split("/").pop() ?? "";
        const id = filenameToDocId(fileName);
        if (id !== undefined) ids.push(id);
      }
      return ids;
    },

    async delete(docId: string): Promise<boolean> {
      const path = docPath(docId);

      // Delete directly — handle NOT_FOUND as "already gone"
      const result: Result<unknown, KoiError> = await transport.call("delete", { path });
      if (!result.ok) {
        if (result.error.code === "NOT_FOUND") return false;
        throwKoiError(result.error);
      }
      return true;
    },
  };
}
