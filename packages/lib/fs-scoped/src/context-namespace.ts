import type {
  ContextNamespace,
  ContextNamespaceChangeEvent,
  ContextNamespaceMount,
  FileDeleteResult,
  FileEditResult,
  FileListResult,
  FileReadResult,
  FileRenameResult,
  FileSearchOptions,
  FileSearchResult,
  FileSystemBackend,
  FileWriteResult,
  KoiError,
  Result,
} from "@koi/core";
import { permission } from "@koi/core";
import { createScopedFileSystem } from "./scoped-filesystem.js";

const VIRTUAL_SCOPE_ROOT = "/__koi_context_namespace__";

function normalizeNamespacePath(path: string): string {
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const parts = withLeadingSlash.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.includes("..")) {
    throw new Error(`Context namespace path cannot contain '..': ${path}`);
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function assertMountPath(path: string): string {
  const normalized = normalizeNamespacePath(path);
  if (normalized === "/") {
    throw new Error("Context namespace cannot mount at root '/'");
  }
  return normalized;
}

function assertAccessMode(mode: ContextNamespaceMount["mode"]): ContextNamespaceMount["mode"] {
  if (mode === "ro" || mode === "rw") return mode;
  throw new Error(`Context namespace access mode must be 'ro' or 'rw', got ${String(mode)}.`);
}

function mountContainsPath(mountPath: string, path: string): boolean {
  return path === mountPath || path.startsWith(`${mountPath}/`);
}

function emit(
  listeners: ReadonlySet<(event: ContextNamespaceChangeEvent) => void>,
  event: ContextNamespaceChangeEvent,
): void {
  for (const listener of listeners) {
    listener(event);
  }
}

function toMountRelativePath(mountPath: string, namespacePath: string): string | undefined {
  const normalized = normalizeNamespacePath(namespacePath);
  if (!mountContainsPath(mountPath, normalized)) {
    return undefined;
  }
  const suffix = normalized.slice(mountPath.length);
  return suffix.length === 0 ? "." : suffix.slice(1);
}

function toBackendPath(virtualPath: string): string | undefined {
  if (virtualPath === VIRTUAL_SCOPE_ROOT) {
    return "/";
  }
  const prefix = `${VIRTUAL_SCOPE_ROOT}/`;
  if (!virtualPath.startsWith(prefix)) {
    return undefined;
  }
  return `/${virtualPath.slice(prefix.length)}`;
}

function pathDenied(path: string, mountPath: string): Result<never, KoiError> {
  return {
    ok: false,
    error: permission(
      `Access to '${path}' was blocked: path is outside context mount '${mountPath}'.`,
    ),
  };
}

type RewritePath = (path: string) => string | undefined;
type MapSearchPath = (path: string) => string;
type RewriteSearchOptions = (
  options: FileSearchOptions | undefined,
) => Result<FileSearchOptions | undefined, KoiError>;

function rewriteOrDeny(
  path: string,
  rewrite: RewritePath,
  mountPath: string,
): Result<string, KoiError> {
  const rewritten = rewrite(path);
  return rewritten === undefined ? pathDenied(path, mountPath) : { ok: true, value: rewritten };
}

function mapResultPath<T extends { readonly path: string }>(
  raw: Result<T, KoiError> | Promise<Result<T, KoiError>>,
  mapPath: MapSearchPath,
): Result<T, KoiError> | Promise<Result<T, KoiError>> {
  const finish = (result: Result<T, KoiError>): Result<T, KoiError> =>
    result.ok ? { ok: true, value: { ...result.value, path: mapPath(result.value.path) } } : result;
  return raw instanceof Promise ? raw.then(finish) : finish(raw);
}

function mapListResult(
  raw: Result<FileListResult, KoiError> | Promise<Result<FileListResult, KoiError>>,
  mapPath: MapSearchPath,
): Result<FileListResult, KoiError> | Promise<Result<FileListResult, KoiError>> {
  const finish = (result: Result<FileListResult, KoiError>): Result<FileListResult, KoiError> =>
    result.ok
      ? {
          ok: true,
          value: {
            entries: result.value.entries.map((entry) => ({
              ...entry,
              path: mapPath(entry.path),
            })),
            truncated: result.value.truncated,
          },
        }
      : result;
  return raw instanceof Promise ? raw.then(finish) : finish(raw);
}

function mapSearchResults(
  raw: Result<FileSearchResult, KoiError> | Promise<Result<FileSearchResult, KoiError>>,
  mapPath: MapSearchPath,
): Result<FileSearchResult, KoiError> | Promise<Result<FileSearchResult, KoiError>> {
  const finish = (
    result: Result<FileSearchResult, KoiError>,
  ): Result<FileSearchResult, KoiError> =>
    result.ok
      ? {
          ok: true,
          value: {
            matches: result.value.matches.map((match) => ({
              ...match,
              path: mapPath(match.path),
            })),
            truncated: result.value.truncated,
          },
        }
      : result;
  return raw instanceof Promise ? raw.then(finish) : finish(raw);
}

function mapRenameResult(
  raw: Result<FileRenameResult, KoiError> | Promise<Result<FileRenameResult, KoiError>>,
  mapPath: MapSearchPath,
): Result<FileRenameResult, KoiError> | Promise<Result<FileRenameResult, KoiError>> {
  const finish = (
    result: Result<FileRenameResult, KoiError>,
  ): Result<FileRenameResult, KoiError> =>
    result.ok
      ? {
          ok: true,
          value: { from: mapPath(result.value.from), to: mapPath(result.value.to) },
        }
      : result;
  return raw instanceof Promise ? raw.then(finish) : finish(raw);
}

function createRoutedRequiredMethods(
  backend: FileSystemBackend,
  rewrite: RewritePath,
  mountPath: string,
  mapSearchPath: MapSearchPath,
  rewriteSearchOptions: RewriteSearchOptions,
): Pick<FileSystemBackend, "read" | "write" | "edit" | "list" | "search"> {
  return {
    read(path, options) {
      const routed = rewriteOrDeny(path, rewrite, mountPath);
      return routed.ok
        ? mapResultPath<FileReadResult>(backend.read(routed.value, options), mapSearchPath)
        : routed;
    },
    write(path, content, options) {
      const routed = rewriteOrDeny(path, rewrite, mountPath);
      return routed.ok
        ? mapResultPath<FileWriteResult>(
            backend.write(routed.value, content, options),
            mapSearchPath,
          )
        : routed;
    },
    edit(path, edits, options) {
      const routed = rewriteOrDeny(path, rewrite, mountPath);
      return routed.ok
        ? mapResultPath<FileEditResult>(backend.edit(routed.value, edits, options), mapSearchPath)
        : routed;
    },
    list(path, options) {
      const routed = rewriteOrDeny(path, rewrite, mountPath);
      return routed.ok ? mapListResult(backend.list(routed.value, options), mapSearchPath) : routed;
    },
    search(pattern, options) {
      const nextOptions = rewriteSearchOptions(options);
      if (!nextOptions.ok) return nextOptions;
      return mapSearchResults(backend.search(pattern, nextOptions.value), mapSearchPath);
    },
  };
}

function createRoutedOptionalMethods(
  backend: FileSystemBackend,
  rewrite: RewritePath,
  mountPath: string,
  mapPath: MapSearchPath,
): Partial<FileSystemBackend> {
  const del = backend.delete;
  const ren = backend.rename;
  const resolveFn = backend.resolvePath;
  const dispose = backend.dispose;
  return {
    ...(del === undefined
      ? {}
      : {
          delete(path: string) {
            const next = rewriteOrDeny(path, rewrite, mountPath);
            return next.ok ? mapResultPath<FileDeleteResult>(del(next.value), mapPath) : next;
          },
        }),
    ...(ren === undefined
      ? {}
      : {
          rename: (from: string, to: string) =>
            routeRename(ren, rewrite, mountPath, mapPath, from, to),
        }),
    ...(resolveFn === undefined
      ? {}
      : {
          resolvePath(path: string) {
            const next = rewrite(path);
            return next === undefined ? undefined : resolveFn(next);
          },
        }),
    ...(dispose === undefined ? {} : { dispose: () => dispose() }),
  };
}

function routeRename(
  rename: NonNullable<FileSystemBackend["rename"]>,
  rewrite: RewritePath,
  mountPath: string,
  mapPath: MapSearchPath,
  from: string,
  to: string,
) {
  const nextFrom = rewriteOrDeny(from, rewrite, mountPath);
  if (!nextFrom.ok) return nextFrom;
  const nextTo = rewriteOrDeny(to, rewrite, mountPath);
  return nextTo.ok ? mapRenameResult(rename(nextFrom.value, nextTo.value), mapPath) : nextTo;
}

function createRoutedBackend(
  name: string,
  backend: FileSystemBackend,
  rewrite: RewritePath,
  mountPath: string,
  mapSearchPath: MapSearchPath,
  rewriteSearchOptions: RewriteSearchOptions = (options) => ({ ok: true, value: options }),
): FileSystemBackend {
  return {
    name,
    ...createRoutedRequiredMethods(
      backend,
      rewrite,
      mountPath,
      mapSearchPath,
      rewriteSearchOptions,
    ),
    ...createRoutedOptionalMethods(backend, rewrite, mountPath, mapSearchPath),
  };
}

function toVirtualPath(backendPath: string): string {
  const normalized = normalizeNamespacePath(backendPath);
  return normalized === "/" ? VIRTUAL_SCOPE_ROOT : `${VIRTUAL_SCOPE_ROOT}${normalized}`;
}

function createVirtualRootBackend(backend: FileSystemBackend): FileSystemBackend {
  return createRoutedBackend(
    `context-namespace-virtual(${backend.name})`,
    backend,
    toBackendPath,
    VIRTUAL_SCOPE_ROOT,
    toVirtualPath,
  );
}

function toNamespaceSearchPath(mountPath: string, virtualPath: string): string {
  const backendPath = toBackendPath(virtualPath) ?? normalizeNamespacePath(virtualPath);
  return backendPath === "/" ? mountPath : `${mountPath}${backendPath}`;
}

function rewriteMountSearchOptions(
  mountPath: string,
  options: FileSearchOptions | undefined,
): Result<FileSearchOptions | undefined, KoiError> {
  if (options?.glob === undefined) return { ok: true, value: options };
  if (!options.glob.startsWith("/")) return { ok: true, value: options };
  const glob = toMountRelativePath(mountPath, options.glob);
  if (glob === undefined) return pathDenied(options.glob, mountPath);
  return { ok: true, value: { ...options, glob } };
}

function createResolvedMountBackend(mount: ContextNamespaceMount): FileSystemBackend {
  const scoped = createScopedFileSystem(createVirtualRootBackend(mount.backend), {
    root: VIRTUAL_SCOPE_ROOT,
    mode: mount.mode,
  });
  return createRoutedBackend(
    `context-namespace(${mount.backend.name}:${mount.path})`,
    scoped,
    (path) => toMountRelativePath(mount.path, path),
    mount.path,
    (path) => toNamespaceSearchPath(mount.path, path),
    (options) => rewriteMountSearchOptions(mount.path, options),
  );
}

function normalizeMount(mount: ContextNamespaceMount, path: string): ContextNamespaceMount {
  const mode = assertAccessMode(mount.mode);
  const base = { path, backend: mount.backend, mode };
  return mount.metadata === undefined ? base : { ...base, metadata: mount.metadata };
}

function toMountedEvent(mount: ContextNamespaceMount): ContextNamespaceChangeEvent {
  const event = { kind: "mounted" as const, path: mount.path, mode: mount.mode };
  return mount.metadata === undefined ? event : { ...event, metadata: mount.metadata };
}

function findMount(
  mounts: Iterable<ContextNamespaceMount>,
  path: string,
): ContextNamespaceMount | undefined {
  return [...mounts]
    .filter((mount) => mountContainsPath(mount.path, path))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

export function createContextNamespace(): ContextNamespace {
  const mounts = new Map<string, ContextNamespaceMount>();
  const resolved = new Map<string, FileSystemBackend>();
  const listeners = new Set<(event: ContextNamespaceChangeEvent) => void>();

  return {
    mount(mount) {
      const path = assertMountPath(mount.path);
      const normalized = normalizeMount(mount, path);
      mounts.set(path, normalized);
      resolved.set(path, createResolvedMountBackend(normalized));
      emit(listeners, toMountedEvent(normalized));
    },

    unmount(path) {
      const normalized = normalizeNamespacePath(path);
      const removed = mounts.delete(normalized);
      resolved.delete(normalized);
      if (removed) {
        emit(listeners, { kind: "unmounted", path: normalized });
      }
      return removed;
    },

    resolve(path) {
      const normalized = normalizeNamespacePath(path);
      const match = findMount(mounts.values(), normalized);
      if (match === undefined) return undefined;
      emit(listeners, {
        kind: "resolved",
        path: normalized,
        mountPath: match.path,
        mode: match.mode,
      });
      return resolved.get(match.path);
    },

    list() {
      return [...mounts.values()];
    },

    watch(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
