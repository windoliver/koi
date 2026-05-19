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

type RewritePath = (path: string) => string | undefined;

function rewriteOrDeny(
  path: string,
  rewrite: RewritePath,
  mountPath: string,
): Result<string, KoiError> {
  const rewritten = rewrite(path);
  return rewritten === undefined ? pathDenied(path, mountPath) : { ok: true, value: rewritten };
}

function createRoutedRequiredMethods(
  backend: FileSystemBackend,
  rewrite: RewritePath,
  mountPath: string,
): Pick<FileSystemBackend, "read" | "write" | "edit" | "list" | "search"> {
  return {
    read(path, options) {
      const routed = rewriteOrDeny(path, rewrite, mountPath);
      return routed.ok ? backend.read(routed.value, options) : routed;
    },
    write(path, content, options) {
      const routed = rewriteOrDeny(path, rewrite, mountPath);
      return routed.ok ? backend.write(routed.value, content, options) : routed;
    },
    edit(path, edits, options) {
      const routed = rewriteOrDeny(path, rewrite, mountPath);
      return routed.ok ? backend.edit(routed.value, edits, options) : routed;
    },
    list(path, options) {
      const routed = rewriteOrDeny(path, rewrite, mountPath);
      return routed.ok ? backend.list(routed.value, options) : routed;
    },
    search(pattern, options) {
      return backend.search(pattern, options);
    },
  };
}

function createRoutedOptionalMethods(
  backend: FileSystemBackend,
  rewrite: RewritePath,
  mountPath: string,
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
            return next.ok ? del(next.value) : next;
          },
        }),
    ...(ren === undefined
      ? {}
      : { rename: (from: string, to: string) => routeRename(ren, rewrite, mountPath, from, to) }),
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
  from: string,
  to: string,
) {
  const nextFrom = rewriteOrDeny(from, rewrite, mountPath);
  if (!nextFrom.ok) return nextFrom;
  const nextTo = rewriteOrDeny(to, rewrite, mountPath);
  return nextTo.ok ? rename(nextFrom.value, nextTo.value) : nextTo;
}

function createRoutedBackend(
  name: string,
  backend: FileSystemBackend,
  rewrite: RewritePath,
  mountPath: string,
): FileSystemBackend {
  return {
    name,
    ...createRoutedRequiredMethods(backend, rewrite, mountPath),
    ...createRoutedOptionalMethods(backend, rewrite, mountPath),
  };
}

function createVirtualRootBackend(backend: FileSystemBackend): FileSystemBackend {
  return createRoutedBackend(
    `context-namespace-virtual(${backend.name})`,
    backend,
    toBackendPath,
    VIRTUAL_SCOPE_ROOT,
  );
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
  );
}

function normalizeMount(mount: ContextNamespaceMount, path: string): ContextNamespaceMount {
  if (mount.metadata === undefined) {
    return { path, backend: mount.backend, mode: mount.mode };
  }
  return { path, backend: mount.backend, mode: mount.mode, metadata: mount.metadata };
}

function toMountedEvent(mount: ContextNamespaceMount): ContextNamespaceChangeEvent {
  if (mount.metadata === undefined) {
    return { kind: "mounted", path: mount.path, mode: mount.mode };
  }
  return { kind: "mounted", path: mount.path, mode: mount.mode, metadata: mount.metadata };
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
