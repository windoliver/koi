import type {
  ContextNamespace,
  ContextNamespaceChangeEvent,
  ContextNamespaceMount,
  FileSystemBackend,
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

function createVirtualRootBackend(backend: FileSystemBackend): FileSystemBackend {
  const del = backend.delete;
  const ren = backend.rename;
  const resolveFn = backend.resolvePath;
  const dispose = backend.dispose;

  return {
    name: `context-namespace-virtual(${backend.name})`,

    read(path, options) {
      const backendPath = toBackendPath(path);
      if (backendPath === undefined) return pathDenied(path, VIRTUAL_SCOPE_ROOT);
      return backend.read(backendPath, options);
    },

    write(path, content, options) {
      const backendPath = toBackendPath(path);
      if (backendPath === undefined) return pathDenied(path, VIRTUAL_SCOPE_ROOT);
      return backend.write(backendPath, content, options);
    },

    edit(path, edits, options) {
      const backendPath = toBackendPath(path);
      if (backendPath === undefined) return pathDenied(path, VIRTUAL_SCOPE_ROOT);
      return backend.edit(backendPath, edits, options);
    },

    list(path, options) {
      const backendPath = toBackendPath(path);
      if (backendPath === undefined) return pathDenied(path, VIRTUAL_SCOPE_ROOT);
      return backend.list(backendPath, options);
    },

    search(pattern, options) {
      return backend.search(pattern, options);
    },

    ...(del !== undefined
      ? {
          delete(path: string) {
            const backendPath = toBackendPath(path);
            if (backendPath === undefined) return pathDenied(path, VIRTUAL_SCOPE_ROOT);
            return del(backendPath);
          },
        }
      : {}),
    ...(ren !== undefined
      ? {
          rename(from: string, to: string) {
            const backendFrom = toBackendPath(from);
            if (backendFrom === undefined) return pathDenied(from, VIRTUAL_SCOPE_ROOT);
            const backendTo = toBackendPath(to);
            if (backendTo === undefined) return pathDenied(to, VIRTUAL_SCOPE_ROOT);
            return ren(backendFrom, backendTo);
          },
        }
      : {}),
    ...(resolveFn !== undefined
      ? {
          resolvePath(path: string): string | undefined {
            const backendPath = toBackendPath(path);
            return backendPath === undefined ? undefined : resolveFn(backendPath);
          },
        }
      : {}),
    ...(dispose !== undefined ? { dispose: () => dispose() } : {}),
  };
}

function createResolvedMountBackend(mount: ContextNamespaceMount): FileSystemBackend {
  const scoped = createScopedFileSystem(createVirtualRootBackend(mount.backend), {
    root: VIRTUAL_SCOPE_ROOT,
    mode: mount.mode,
  });

  const rewrite = (path: string): string | undefined => toMountRelativePath(mount.path, path);
  const del = scoped.delete;
  const ren = scoped.rename;
  const resolveFn = scoped.resolvePath;
  const dispose = scoped.dispose;

  return {
    name: `context-namespace(${mount.backend.name}:${mount.path})`,

    read(path, options) {
      const relative = rewrite(path);
      if (relative === undefined) return pathDenied(path, mount.path);
      return scoped.read(relative, options);
    },

    write(path, content, options) {
      const relative = rewrite(path);
      if (relative === undefined) return pathDenied(path, mount.path);
      return scoped.write(relative, content, options);
    },

    edit(path, edits, options) {
      const relative = rewrite(path);
      if (relative === undefined) return pathDenied(path, mount.path);
      return scoped.edit(relative, edits, options);
    },

    list(path, options) {
      const relative = rewrite(path);
      if (relative === undefined) return pathDenied(path, mount.path);
      return scoped.list(relative, options);
    },

    search(pattern, options) {
      return scoped.search(pattern, options);
    },

    ...(del !== undefined
      ? {
          delete(path: string) {
            const relative = rewrite(path);
            if (relative === undefined) return pathDenied(path, mount.path);
            return del(relative);
          },
        }
      : {}),
    ...(ren !== undefined
      ? {
          rename(from: string, to: string) {
            const relativeFrom = rewrite(from);
            if (relativeFrom === undefined) return pathDenied(from, mount.path);
            const relativeTo = rewrite(to);
            if (relativeTo === undefined) return pathDenied(to, mount.path);
            return ren(relativeFrom, relativeTo);
          },
        }
      : {}),
    ...(resolveFn !== undefined
      ? {
          resolvePath(path: string): string | undefined {
            const relative = rewrite(path);
            return relative === undefined ? undefined : resolveFn(relative);
          },
        }
      : {}),
    ...(dispose !== undefined ? { dispose: () => dispose() } : {}),
  };
}

export function createContextNamespace(): ContextNamespace {
  const mounts = new Map<string, ContextNamespaceMount>();
  const resolved = new Map<string, FileSystemBackend>();
  const listeners = new Set<(event: ContextNamespaceChangeEvent) => void>();

  return {
    mount(mount) {
      const path = assertMountPath(mount.path);
      const normalized: ContextNamespaceMount =
        mount.metadata === undefined
          ? { path, backend: mount.backend, mode: mount.mode }
          : { path, backend: mount.backend, mode: mount.mode, metadata: mount.metadata };
      mounts.set(path, normalized);
      resolved.set(path, createResolvedMountBackend(normalized));
      emit(
        listeners,
        normalized.metadata === undefined
          ? { kind: "mounted", path, mode: normalized.mode }
          : { kind: "mounted", path, mode: normalized.mode, metadata: normalized.metadata },
      );
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
      const match = [...mounts.values()]
        .filter((mount) => mountContainsPath(mount.path, normalized))
        .sort((left, right) => right.path.length - left.path.length)[0];
      if (match === undefined) {
        return undefined;
      }
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
