/**
 * Multi-mount Nexus backend.
 *
 * Wraps N `createNexusFileSystem` sub-backends (one per reported mount) and
 * dispatches each op to the backend whose mount prefix matches the input path.
 * Exposes a synthetic `list("/")` so callers can discover mounts without
 * needing out-of-band knowledge of what the bridge reported.
 *
 * Used by `@koi/runtime`'s `resolveFileSystemAsync` when the local bridge
 * reports two or more mounts (e.g., `local://./` + `gdrive://my-drive`).
 * For single-mount configs, call `createNexusFileSystem` directly — this
 * wrapper's overhead only pays for itself when there are actual routing
 * decisions to make.
 */

import type {
  FileDeleteResult,
  FileEdit,
  FileEditOptions,
  FileEditResult,
  FileListOptions,
  FileListResult,
  FileReadOptions,
  FileReadResult,
  FileRenameResult,
  FileSearchOptions,
  FileSearchResult,
  FileSystemBackend,
  FileWriteOptions,
  FileWriteResult,
  KoiError,
  Result,
} from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { createNexusFileSystem } from "./nexus-filesystem-backend.js";
import type { NexusTransport } from "./types.js";

export interface MultiMountConfig {
  readonly transport: NexusTransport;
  /**
   * Mount paths as reported by the bridge's `ready` notification
   * (e.g., `["/local/workspace", "/gdrive"]`). Each must begin with `/`
   * and be unique. Order matters for overlapping prefixes: earlier entries
   * win, so `/local/a` must precede `/local/a/b` if both are present.
   */
  readonly mountPoints: readonly string[];
}

interface Route {
  readonly backend: FileSystemBackend;
  readonly relativePath: string;
}

function notFoundForUnknownMount(path: string, mountPoints: readonly string[]): KoiError {
  return {
    code: "NOT_FOUND",
    message:
      `Path '${path}' does not match any mounted namespace. ` +
      `Available mounts: ${mountPoints.join(", ")}. ` +
      `Use the namespace prefix as the leading path segment (e.g. '${mountPoints[0]}/file.txt').`,
    retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
    context: { path, mountPoints },
  };
}

function validateMountPoints(mountPoints: readonly string[]): void {
  if (mountPoints.length === 0) {
    throw new Error("createNexusMultiMountFileSystem requires at least one mountPoint");
  }
  const seen = new Set<string>();
  for (const mp of mountPoints) {
    if (!mp.startsWith("/")) {
      throw new Error(`mountPoint '${mp}' must begin with '/'`);
    }
    if (mp.length === 1) {
      throw new Error(`mountPoint must not be '/' (empty namespace)`);
    }
    if (seen.has(mp)) {
      throw new Error(`duplicate mountPoint '${mp}'`);
    }
    seen.add(mp);
  }
}

/**
 * Create a routing backend that dispatches each op to the right sub-backend
 * based on the leading mount-prefix of the input path.
 */
export function createNexusMultiMountFileSystem(config: MultiMountConfig): FileSystemBackend {
  validateMountPoints(config.mountPoints);

  // Build sub-backends: one per mount, sharing the transport. Each sub-backend
  // already applies its mountPoint as a prefix to every op, so we pass
  // mount-relative paths and let it reattach the namespace.
  const subBackends: readonly FileSystemBackend[] = config.mountPoints.map((mp) =>
    createNexusFileSystem({
      url: "local://bridge",
      transport: config.transport,
      mountPoint: mp.replace(/^\/+/, ""),
    }),
  );

  function route(path: string): Route | undefined {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    for (let i = 0; i < config.mountPoints.length; i++) {
      const mp = config.mountPoints[i];
      if (mp === undefined) continue; // unreachable — validated above
      if (normalized === mp) {
        const backend = subBackends[i];
        if (backend === undefined) continue;
        return { backend, relativePath: "/" };
      }
      const mpSlash = mp.endsWith("/") ? mp : `${mp}/`;
      if (normalized.startsWith(mpSlash)) {
        const backend = subBackends[i];
        if (backend === undefined) continue;
        return { backend, relativePath: normalized.slice(mp.length) };
      }
    }
    return undefined;
  }

  // Synthetic root listing so `list("/")` returns each mount as a directory.
  // Without this, discovery of mount names requires out-of-band knowledge.
  function syntheticRootList(): FileListResult {
    return {
      entries: config.mountPoints.map((mp) => ({ path: mp, kind: "directory" as const })),
      truncated: false,
    };
  }

  async function read(
    path: string,
    options?: FileReadOptions,
  ): Promise<Result<FileReadResult, KoiError>> {
    const r = route(path);
    if (r === undefined)
      return { ok: false, error: notFoundForUnknownMount(path, config.mountPoints) };
    return r.backend.read(r.relativePath, options);
  }

  async function write(
    path: string,
    content: string,
    options?: FileWriteOptions,
  ): Promise<Result<FileWriteResult, KoiError>> {
    const r = route(path);
    if (r === undefined)
      return { ok: false, error: notFoundForUnknownMount(path, config.mountPoints) };
    return r.backend.write(r.relativePath, content, options);
  }

  async function edit(
    path: string,
    edits: readonly FileEdit[],
    options?: FileEditOptions,
  ): Promise<Result<FileEditResult, KoiError>> {
    const r = route(path);
    if (r === undefined)
      return { ok: false, error: notFoundForUnknownMount(path, config.mountPoints) };
    return r.backend.edit(r.relativePath, edits, options);
  }

  async function list(
    path: string,
    options?: FileListOptions,
  ): Promise<Result<FileListResult, KoiError>> {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (normalized === "/" || normalized === "") {
      return { ok: true, value: syntheticRootList() };
    }
    const r = route(path);
    if (r === undefined)
      return { ok: false, error: notFoundForUnknownMount(path, config.mountPoints) };
    return r.backend.list(r.relativePath, options);
  }

  async function search(
    pattern: string,
    options?: FileSearchOptions,
  ): Promise<Result<FileSearchResult, KoiError>> {
    // Global search doesn't map cleanly to a single mount — delegate to the
    // first backend and return its results. Callers that need cross-mount
    // search should issue per-mount queries explicitly.
    const first = subBackends[0];
    if (first === undefined) {
      return { ok: false, error: notFoundForUnknownMount("/", config.mountPoints) };
    }
    return first.search(pattern, options);
  }

  async function del(path: string): Promise<Result<FileDeleteResult, KoiError>> {
    const r = route(path);
    if (r === undefined)
      return { ok: false, error: notFoundForUnknownMount(path, config.mountPoints) };
    if (r.backend.delete === undefined) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "delete not supported by underlying backend",
          retryable: false,
        },
      };
    }
    return r.backend.delete(r.relativePath);
  }

  async function rename(from: string, to: string): Promise<Result<FileRenameResult, KoiError>> {
    const rFrom = route(from);
    const rTo = route(to);
    if (rFrom === undefined)
      return { ok: false, error: notFoundForUnknownMount(from, config.mountPoints) };
    if (rTo === undefined)
      return { ok: false, error: notFoundForUnknownMount(to, config.mountPoints) };
    if (rFrom.backend !== rTo.backend) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Cannot rename across mounts: '${from}' and '${to}' belong to different namespaces`,
          retryable: false,
          context: { from, to },
        },
      };
    }
    if (rFrom.backend.rename === undefined) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "rename not supported by underlying backend",
          retryable: false,
        },
      };
    }
    return rFrom.backend.rename(rFrom.relativePath, rTo.relativePath);
  }

  async function dispose(): Promise<void> {
    // All sub-backends share the transport; disposing the first one closes it.
    // The remainder become no-ops against a closed transport, which is safe.
    await subBackends[0]?.dispose?.();
  }

  return {
    name: `nexus-multi:${config.mountPoints.join(",")}`,
    read,
    write,
    edit,
    list,
    search,
    delete: del,
    rename,
    dispose,
  };
}
