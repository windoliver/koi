/**
 * Enforced backend wrappers — pluggable policy enforcement on top of scoped backends.
 *
 * Composition pattern:
 *   raw backend → createScopedXxx (local boundary checks) → createEnforcedXxx (pluggable policy)
 *
 * Each wrapper calls `enforcer.checkAccess()` before delegating to the underlying backend.
 * The enforcer can be sync (local) or async (HTTP/database) — callers always await.
 */

import type {
  BrowserDriver,
  CredentialComponent,
  FileSystemBackend,
  KoiError,
  MemoryComponent,
  MemoryRecallOptions,
  MemoryResult,
  MemoryStoreOptions,
  Result,
  ScopeEnforcer,
} from "@koi/core";
import { permission } from "@koi/core";

// ---------------------------------------------------------------------------
// Filesystem enforcement
// ---------------------------------------------------------------------------

export function createEnforcedFileSystem(
  backend: FileSystemBackend,
  enforcer: ScopeEnforcer,
): FileSystemBackend {
  async function check(op: string, resource: string): Promise<KoiError | undefined> {
    const allowed = await enforcer.checkAccess({
      subsystem: "filesystem",
      operation: op,
      resource,
    });
    return allowed
      ? undefined
      : permission(`Filesystem ${op} on '${resource}' was denied by scope enforcer.`);
  }

  const del = backend.delete;
  const enforcedDelete: Pick<FileSystemBackend, "delete"> = del
    ? {
        delete: async (filePath: string) => {
          const err = await check("delete", filePath);
          if (err !== undefined) return { ok: false, error: err } satisfies Result<never, KoiError>;
          return del(filePath);
        },
      }
    : {};

  const ren = backend.rename;
  const enforcedRename: Pick<FileSystemBackend, "rename"> = ren
    ? {
        rename: async (from: string, to: string) => {
          const errFrom = await check("rename", from);
          if (errFrom !== undefined)
            return { ok: false, error: errFrom } satisfies Result<never, KoiError>;
          const errTo = await check("rename", to);
          if (errTo !== undefined)
            return { ok: false, error: errTo } satisfies Result<never, KoiError>;
          return ren(from, to);
        },
      }
    : {};

  const backendDispose = backend.dispose;
  const enforcerDispose = enforcer.dispose;
  const needsDispose = backendDispose !== undefined || enforcerDispose !== undefined;
  const enforcedDispose: Pick<FileSystemBackend, "dispose"> = needsDispose
    ? {
        async dispose() {
          await backendDispose?.();
          await enforcerDispose?.();
        },
      }
    : {};

  return {
    name: `enforced(${backend.name})`,

    async read(filePath, options) {
      const err = await check("read", filePath);
      if (err !== undefined) return { ok: false, error: err } satisfies Result<never, KoiError>;
      return backend.read(filePath, options);
    },

    async write(filePath, content, options) {
      const err = await check("write", filePath);
      if (err !== undefined) return { ok: false, error: err } satisfies Result<never, KoiError>;
      return backend.write(filePath, content, options);
    },

    async edit(filePath, edits, options) {
      const err = await check("edit", filePath);
      if (err !== undefined) return { ok: false, error: err } satisfies Result<never, KoiError>;
      return backend.edit(filePath, edits, options);
    },

    async list(dirPath, options) {
      const err = await check("list", dirPath);
      if (err !== undefined) return { ok: false, error: err } satisfies Result<never, KoiError>;
      return backend.list(dirPath, options);
    },

    async search(pattern, options) {
      const err = await check("search", pattern);
      if (err !== undefined) return { ok: false, error: err } satisfies Result<never, KoiError>;
      return backend.search(pattern, options);
    },

    ...enforcedDelete,
    ...enforcedRename,
    ...enforcedDispose,
  };
}

// ---------------------------------------------------------------------------
// Browser enforcement
// ---------------------------------------------------------------------------

export function createEnforcedBrowser(
  driver: BrowserDriver,
  enforcer: ScopeEnforcer,
): BrowserDriver {
  async function checkNav(url: string): Promise<KoiError | undefined> {
    const allowed = await enforcer.checkAccess({
      subsystem: "browser",
      operation: "navigate",
      resource: url,
    });
    return allowed ? undefined : permission(`Navigation to '${url}' was denied by scope enforcer.`);
  }

  const upload = driver.upload;
  const enforcedUpload: Pick<BrowserDriver, "upload"> = upload
    ? { upload: (ref, files, options) => upload(ref, files, options) }
    : {};

  const traceStart = driver.traceStart;
  const enforcedTraceStart: Pick<BrowserDriver, "traceStart"> = traceStart
    ? { traceStart: (options) => traceStart(options) }
    : {};

  const traceStop = driver.traceStop;
  const enforcedTraceStop: Pick<BrowserDriver, "traceStop"> = traceStop
    ? { traceStop: () => traceStop() }
    : {};

  const driverDispose = driver.dispose;
  const enforcerDispose = enforcer.dispose;
  const needsDispose = driverDispose !== undefined || enforcerDispose !== undefined;
  const enforcedDispose: Pick<BrowserDriver, "dispose"> = needsDispose
    ? {
        async dispose() {
          await driverDispose?.();
          await enforcerDispose?.();
        },
      }
    : {};

  return {
    name: `enforced(${driver.name})`,

    snapshot(options) {
      return driver.snapshot(options);
    },

    async navigate(url, options) {
      const err = await checkNav(url);
      if (err !== undefined) return { ok: false, error: err } satisfies Result<never, KoiError>;
      return driver.navigate(url, options);
    },

    click(ref, options) {
      return driver.click(ref, options);
    },

    type(ref, value, options) {
      return driver.type(ref, value, options);
    },

    select(ref, value, options) {
      return driver.select(ref, value, options);
    },

    fillForm(fields, options) {
      return driver.fillForm(fields, options);
    },

    scroll(options) {
      return driver.scroll(options);
    },

    screenshot(options) {
      return driver.screenshot(options);
    },

    wait(options) {
      return driver.wait(options);
    },

    async tabNew(options) {
      if (options?.url !== undefined) {
        const err = await checkNav(options.url);
        if (err !== undefined) return { ok: false, error: err } satisfies Result<never, KoiError>;
      }
      return driver.tabNew(options);
    },

    tabClose(tabId, options) {
      return driver.tabClose(tabId, options);
    },

    tabFocus(tabId, options) {
      return driver.tabFocus(tabId, options);
    },

    evaluate(script, options) {
      return driver.evaluate(script, options);
    },

    hover(ref, options) {
      return driver.hover(ref, options);
    },

    press(key, options) {
      return driver.press(key, options);
    },

    tabList() {
      return driver.tabList();
    },

    console(options) {
      return driver.console(options);
    },

    ...enforcedUpload,
    ...enforcedTraceStart,
    ...enforcedTraceStop,
    ...enforcedDispose,
  };
}

// ---------------------------------------------------------------------------
// Credentials enforcement
// ---------------------------------------------------------------------------

export function createEnforcedCredentials(
  component: CredentialComponent,
  enforcer: ScopeEnforcer,
): CredentialComponent {
  return {
    async get(key: string): Promise<string | undefined> {
      const allowed = await enforcer.checkAccess({
        subsystem: "credentials",
        operation: "get",
        resource: key,
      });
      if (!allowed) return undefined;
      return component.get(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Memory enforcement
// ---------------------------------------------------------------------------

export function createEnforcedMemory(
  component: MemoryComponent,
  enforcer: ScopeEnforcer,
): MemoryComponent {
  return {
    async store(content: string, options?: MemoryStoreOptions): Promise<void> {
      const resource = options?.namespace ?? "default";
      const allowed = await enforcer.checkAccess({
        subsystem: "memory",
        operation: "store",
        resource,
      });
      if (!allowed) {
        return; // Silently deny — consistent with credentials pattern (least information)
      }
      return component.store(content, options);
    },

    async recall(query: string, options?: MemoryRecallOptions): Promise<readonly MemoryResult[]> {
      const resource = options?.namespace ?? "default";
      const allowed = await enforcer.checkAccess({
        subsystem: "memory",
        operation: "recall",
        resource,
      });
      if (!allowed) return [];
      return component.recall(query, options);
    },
  };
}
