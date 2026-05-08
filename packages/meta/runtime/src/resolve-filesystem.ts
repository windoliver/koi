/**
 * Filesystem backend dispatch — resolves manifest config to a FileSystemBackend.
 *
 * Follows the existing resolveAdapter()/resolveChannel() pattern in create-runtime.ts.
 * Dispatch logic lives here (L3) instead of L1, keeping the engine vendor-free.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { FileSystemBackend, FileSystemConfig, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { createLocalFileSystem } from "@koi/fs-local";
import type { BridgeNotification, MountDescription } from "@koi/fs-nexus";
import {
  createLocalTransport,
  createNexusFileSystem,
  validateNexusFileSystemConfig,
} from "@koi/fs-nexus";
import { createScopedFileSystem } from "@koi/fs-scoped";
import { createScopedFs } from "@koi/governance-scope";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schema for manifest-level filesystem config (internal)
// ---------------------------------------------------------------------------

const fileSystemConfigSchema = z
  .object({
    backend: z.enum(["local", "nexus"]).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    operations: z.array(z.enum(["read", "write", "edit"])).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Glob-allowlist scope (gov-15) — multi-glob alternative to single-root scope.
// Activated when manifest options.allow is provided as a non-empty string[].
// ---------------------------------------------------------------------------

interface GlobScope {
  readonly allow: readonly string[];
  readonly mode: "ro" | "rw";
}

function extractGlobScope(
  options: Record<string, unknown> | undefined,
  cwd: string,
  backendType: "local" | "nexus",
): GlobScope | undefined {
  // Absent `options` or `options.allow` → no glob scope configured.
  // Falls through to legacy single-root scope or unscoped backend.
  if (options === undefined || options === null) return undefined;
  if (!("allow" in options)) return undefined;
  const allowRaw = options.allow;

  // gov-15: `allow` is a security field. Malformed values must fail
  // closed (throw) rather than silently disable scope — `allow: 42` or
  // `allow: ["", 7]` are operator typos that, under the previous
  // "return undefined" behavior, would have removed the intended
  // boundary. The throw surfaces at TUI/CLI startup so the operator
  // sees the error before any agent is wired.
  if (!Array.isArray(allowRaw)) {
    throw new Error(
      "filesystem.options.allow must be an array of glob strings (got non-array). " +
        "Empty array is allowed and means deny-all.",
    );
  }
  if (!allowRaw.every((p): p is string => typeof p === "string" && p.length > 0)) {
    throw new Error(
      "filesystem.options.allow entries must be non-empty strings. " +
        "Reject malformed entries rather than silently disabling scope.",
    );
  }

  const mode = options.mode;
  const resolvedMode: "ro" | "rw" = mode === "rw" ? "rw" : "ro";

  // For local backends, normalize each glob's static prefix the same way
  // extractScope normalizes a single root: resolve relative segments
  // against cwd, then realpathSync the static prefix so symlinked paths
  // (e.g. macOS /var → /private/var) line up with what scoped-fs sees
  // after realpath. The wildcard tail (after the first `*` / `?`) is
  // re-appended verbatim. Nexus/remote backends keep their patterns
  // lexical to avoid resolving remote paths through the local FS.
  const resolved =
    backendType === "local" ? allowRaw.map((p) => normalizeAllowPattern(p, cwd)) : allowRaw;

  return { allow: resolved, mode: resolvedMode };
}

function normalizeAllowPattern(pattern: string, cwd: string): string {
  // Find first wildcard to split prefix from glob tail.
  const wildcardIdx = pattern.search(/[*?]/);
  if (wildcardIdx === -1) {
    // No wildcard — treat as a single concrete path; realpath if possible.
    const abs = resolve(cwd, pattern);
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  }
  // Split at the last separator before the wildcard so the prefix is a
  // real directory rather than half a glob segment.
  const prefixEnd = pattern.lastIndexOf("/", wildcardIdx);
  const prefix = prefixEnd === -1 ? "" : pattern.slice(0, prefixEnd);
  const tail = prefixEnd === -1 ? pattern : pattern.slice(prefixEnd);
  if (prefix === "") return pattern;
  const absPrefix = resolve(cwd, prefix);
  try {
    return realpathSync(absPrefix) + tail;
  } catch {
    return absPrefix + tail;
  }
}

function connectorNameFromPath(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts[0] ?? "unknown";
}

function cheapMountDescription(path: string): MountDescription {
  return { path, connector: connectorNameFromPath(path) };
}

/**
 * Synchronous, network-free seed for the prompt-injection middleware.
 *
 * Intentionally does NOT call `describeMount` — that RPC may force OAuth or
 * connector-warmup work and would turn cosmetic prompt enrichment into a
 * blocking dependency on TUI startup. Callers that want richer descriptions
 * (e.g. README content) should refresh asynchronously after startup.
 */
function seedManifestMountDescriptions(
  transport: import("@koi/fs-nexus").NexusTransport,
): readonly MountDescription[] {
  const mounts = transport.mounts ?? [];
  return [...mounts.map(cheapMountDescription)].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Validate raw manifest input as a FileSystemConfig.
 *
 * Returns `Result<FileSystemConfig, KoiError>` — never throws for validation errors.
 * Use this to validate YAML/JSON manifest `filesystem:` sections.
 */
export function validateFileSystemConfig(raw: unknown): Result<FileSystemConfig, KoiError> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: {} };
  }
  const result = fileSystemConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues;
    const messages = issues
      .map((i: z.core.$ZodIssue) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid filesystem config: ${messages}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: result.data as FileSystemConfig };
}

// ---------------------------------------------------------------------------
// Scope extraction
// ---------------------------------------------------------------------------

/**
 * Extracts scope config from `options` if both `root` (string) and `mode`
 * ("ro" | "rw") are present and valid. Returns `undefined` for partial/absent
 * scope so callers can skip wrapping.
 *
 * Relative `root` values are resolved against the given `cwd`.
 */
function extractScope(
  options: Record<string, unknown> | undefined,
  cwd: string,
  backendType: "local" | "nexus",
): { readonly root: string; readonly mode: "ro" | "rw" } | undefined {
  if (options === undefined || options === null) return undefined;
  const root = options.root;
  const mode = options.mode;
  if (typeof root !== "string" || root.length === 0) return undefined;
  if (mode !== "ro" && mode !== "rw") return undefined;

  let resolvedRoot: string;
  if (backendType === "local") {
    // Use realpathSync for local backends to match fs-local's own root
    // normalization, ensuring symlink-based paths (e.g. /var/folders →
    // /private/var/folders on macOS) agree.
    try {
      resolvedRoot = realpathSync(resolve(cwd, root));
    } catch {
      // Directory may not exist yet — fall back to resolve() without realpath.
      resolvedRoot = resolve(cwd, root);
    }
  } else {
    // For nexus/remote backends, keep the path lexical. realpathSync would
    // resolve against the HOST filesystem, rewriting remote paths through
    // local symlinks — a trust-boundary violation that can redirect or reject
    // valid remote paths based on the operator's local directory layout.
    resolvedRoot = resolve(cwd, root);
  }
  return { root: resolvedRoot, mode };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Resolve a FileSystemConfig to a concrete FileSystemBackend.
 *
 * @param config - Manifest filesystem config. Undefined/absent defaults to local.
 * @param cwd - Working directory for the local backend. Required when backend is "local".
 * @returns A FileSystemBackend ready for use.
 * @throws On invalid config (e.g., nexus without url).
 */
export function resolveFileSystem(
  config: FileSystemConfig | undefined,
  cwd: string,
): FileSystemBackend {
  const backendKind = config?.backend ?? "local";
  const optionsRecord = config?.options as Record<string, unknown> | undefined;
  // Glob-allowlist scope (gov-15) takes precedence over legacy single-root.
  const globScope = extractGlobScope(optionsRecord, cwd, backendKind);
  // Legacy single-root scope: only consulted when glob scope is absent.
  const scope = globScope === undefined ? extractScope(optionsRecord, cwd, backendKind) : undefined;

  let backend: FileSystemBackend;
  if (backendKind === "local") {
    // gov-15: rw glob scope on the local backend is fail-closed disabled
    // until the backend supports atomic no-follow writes (O_NOFOLLOW /
    // openat). The current path is: pre-validate path → backend writes
    // via fs.writeFile (which auto-follows symlinks). A concurrent
    // attacker can race-replace the leaf with a symlink between the
    // check and the write, causing the write to land outside the
    // allowlist. The post-write revalidation in scoped-fs catches and
    // unlinks the leak, but the data has already crossed the boundary.
    //
    // Operators wanting writable scope today should use single-root
    // scope (`filesystem.options.root` + `mode: "rw"`) — the local
    // backend's root realpath check + `allowExternalPaths: false`
    // provides the structural boundary for that path. ro glob scope
    // (`mode: "ro"`) is unaffected: reads cannot corrupt.
    if (globScope !== undefined && globScope.mode === "rw") {
      throw new Error(
        "filesystem.options.allow with mode: 'rw' is not supported on the local backend. " +
          "rw glob scope requires atomic no-follow write support that the local backend " +
          "does not yet provide; without it, a symlink race can land writes outside the " +
          "allowlist. Use single-root scope (filesystem.options.root + mode: 'rw') for " +
          "writable scope, or mode: 'ro' for read-only glob scope.",
      );
    }
    // Single-root scope: root the local backend at the scope root so its
    // own workspace check aligns with the scope boundary.
    // Glob scope: the scope wrapper IS the boundary, so opt the local
    // backend out of its workspace check via allowExternalPaths — otherwise
    // a glob like /tmp/x/** would be rejected by the local backend before
    // our wrapper sees it.
    if (scope !== undefined) {
      backend = createLocalFileSystem(scope.root);
    } else if (globScope !== undefined) {
      backend = createLocalFileSystem(cwd, { allowExternalPaths: true });
    } else {
      backend = createLocalFileSystem(cwd);
    }
  } else {
    // backend === "nexus"
    const validated = validateNexusFileSystemConfig(config?.options ?? {});
    if (!validated.ok) {
      throw new Error(`Invalid nexus filesystem config: ${validated.error.message}`);
    }
    backend = createNexusFileSystem(validated.value);
  }

  if (globScope !== undefined) {
    return createScopedFs(backend, globScope);
  }
  if (scope !== undefined) {
    return createScopedFileSystem(backend, scope);
  }
  return backend;
}

// ---------------------------------------------------------------------------
// Async variant — local bridge transport with auth notification wiring
// ---------------------------------------------------------------------------

/**
 * Options for the local bridge transport when used via resolveFileSystemAsync.
 *
 * Set `filesystem.backend: "nexus"` and `filesystem.options.transport: "local"`
 * in your manifest/config to activate this path.
 */
interface LocalBridgeOptions {
  readonly transport: "local";
  /** One or more nexus-fs mount URIs (e.g. "gdrive://my-drive", "local://./workspace"). */
  readonly mountUri: string | readonly string[];
  /** Python 3 executable path. Default: "python3". */
  readonly pythonPath?: string | undefined;
  /** Startup timeout for the bridge process (ms). Default: 10_000. */
  readonly startupTimeoutMs?: number | undefined;
  /** Per-RPC call timeout (ms). Default: 30_000. */
  readonly callTimeoutMs?: number | undefined;
  /** Max time to wait for the user to complete OAuth (ms). Default: 300_000. */
  readonly authTimeoutMs?: number | undefined;
  /**
   * Nexus path prefix used for namespace isolation (e.g. per-tenant scoping).
   * Forwarded to createNexusFileSystem — must match the synchronous Nexus path.
   * Default: "fs" (the createNexusFileSystem default).
   */
  readonly mountPoint?: string | undefined;
  /**
   * Environment variables forwarded to the bridge subprocess.
   * Use for credentials the bridge needs (AWS keys, GCS credentials, etc.).
   * Merged with and overrides the parent process environment.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

const localBridgeOptionsSchema = z
  .object({
    transport: z.literal("local"),
    mountUri: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    pythonPath: z.string().optional(),
    startupTimeoutMs: z.number().positive().optional(),
    callTimeoutMs: z.number().positive().optional(),
    authTimeoutMs: z.number().positive().optional(),
    // Empty string is a valid value: it opts into Nexus-root semantics for
    // multi-mount local-bridge sessions (see resolveFileSystemAsync). Schema
    // therefore accepts any string, including "". Path-traversal validation
    // ("..") still happens inside createNexusFileSystem.
    mountPoint: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

function parseLocalBridgeOptions(
  v: unknown,
): { ok: true; value: LocalBridgeOptions } | { ok: false; error: string } {
  if (typeof v !== "object" || v === null) return { ok: false, error: "options must be an object" };
  if ((v as Record<string, unknown>).transport !== "local")
    return { ok: false, error: "not a local bridge config" };
  const result = localBridgeOptionsSchema.safeParse(v);
  if (!result.success) {
    const messages = result.error.issues
      .map((i: z.core.$ZodIssue) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `Invalid local bridge options: ${messages}` };
  }
  return { ok: true, value: result.data as LocalBridgeOptions };
}

/**
 * Async version of resolveFileSystem — handles the local bridge transport path.
 *
 * Use this when `filesystem.options.transport === "local"` to:
 * 1. Spawn the nexus-fs Python bridge subprocess
 * 2. Subscribe to auth notifications with the provided handler
 * 3. Return a FileSystemBackend ready for createRuntime()
 *
 * The returned backend's `dispose()` closes the subprocess and unsubscribes.
 *
 * Example:
 *
 *   const backend = await resolveFileSystemAsync(
 *     { backend: "nexus", options: { transport: "local", mountUri: "gdrive://my-drive" } },
 *     process.cwd(),
 *     createAuthNotificationHandler(channel),
 *   );
 *   const { backend, operations, transport } = await resolveFileSystemAsync(..., handler);
 *   const runtime = createRuntime({ filesystem: backend, filesystemOperations: operations });
 *
 *   // Remote OAuth (mode: "remote"): wire pasted redirect URLs back to the bridge.
 *   // When the channel receives a user message that looks like a redirect URL,
 *   // call transport.submitAuthCode(url, notification.params.correlation_id).
 *   // This is the caller's responsibility — resolveFileSystemAsync() cannot
 *   // wire the inbound channel handler because it has no channel reference.
 *   // On shutdown: await backend.dispose?.()
 *
 * @param config - Manifest filesystem config.
 * @param cwd - Working directory (used when backend is "local").
 * @param onNotification - Called when auth_required / auth_progress / auth_complete
 *   notifications arrive from the bridge. Wire createAuthNotificationHandler(channel) here.
 * @returns `{ backend, operations }` — pass both to createRuntime to preserve write/edit grants.
 */
export async function resolveFileSystemAsync(
  config: FileSystemConfig | undefined,
  cwd: string,
  onNotification?: ((n: BridgeNotification) => void) | undefined,
): Promise<{
  readonly backend: FileSystemBackend;
  readonly operations: readonly ("read" | "write" | "edit")[] | undefined;
  readonly mountDescriptions: readonly MountDescription[];
  /**
   * The underlying local bridge transport, only present when
   * `filesystem.options.transport === "local"`. Callers must use this to
   * forward pasted redirect URLs for the remote OAuth flow via
   * `transport.submitAuthCode(url, correlationId)`.
   */
  readonly transport: import("@koi/fs-nexus").NexusTransport | undefined;
  /**
   * Whether `/mount` and `/unmount` runtime operations are safe in this session.
   *
   * False when the backend was initialized with an inferred single-mount root
   * (legacy compat for manifests that omit `mountPoint`): in that mode bare
   * paths resolve under the inferred root, but the backend cannot retarget
   * itself when mounts change at runtime, so allowing add/remove would leave
   * the session pointing at a stale or removed root. Operators who need
   * runtime mount mutation must set `mountPoint` explicitly (or accept the
   * namespace-root default).
   */
  readonly runtimeMountMutationsSupported: boolean;
  /**
   * The mount path the backend resolves bare paths against, when one is
   * fixed at construction time. Callers MUST refuse `/unmount <path>` when
   * `path === backendActiveRoot` — removing the active root strands the
   * session on a dead mount because the backend cannot retarget itself.
   *
   * Undefined when no fixed root exists (namespace-root mode or non-bridge
   * backends), in which case unmounting any path is safe.
   */
  readonly backendActiveRoot: string | undefined;
}> {
  const fsBackend = config?.backend ?? "local";
  // Preserve operation grants from the config — callers must forward these to
  // createRuntime({ filesystemOperations: operations }) to avoid read-only regression.
  const operations = config?.operations;

  // Extract scope once — applied to every backend return path below.
  const optionsRecord = config?.options as Record<string, unknown> | undefined;
  const globScope = extractGlobScope(optionsRecord, cwd, fsBackend);
  const scope = globScope === undefined ? extractScope(optionsRecord, cwd, fsBackend) : undefined;

  // Non-nexus or nexus-http → synchronous resolution (no async needed)
  if (fsBackend === "local") {
    // gov-15: mirror the sync resolver's fail-closed guard on rw glob
    // scope. The async path is what TUI uses; without this check the
    // symlink race the sync path explicitly blocks would be reachable
    // in production. See resolveFileSystem (sync) for the full rationale.
    if (globScope !== undefined && globScope.mode === "rw") {
      throw new Error(
        "filesystem.options.allow with mode: 'rw' is not supported on the local backend. " +
          "rw glob scope requires atomic no-follow write support that the local backend " +
          "does not yet provide; without it, a symlink race can land writes outside the " +
          "allowlist. Use single-root scope (filesystem.options.root + mode: 'rw') for " +
          "writable scope, or mode: 'ro' for read-only glob scope.",
      );
    }
    // See resolveFileSystem for the rationale on allowExternalPaths under glob scope.
    const rawBackend =
      scope !== undefined
        ? createLocalFileSystem(scope.root)
        : globScope !== undefined
          ? createLocalFileSystem(cwd, { allowExternalPaths: true })
          : createLocalFileSystem(cwd);
    const backend =
      globScope !== undefined
        ? createScopedFs(rawBackend, globScope)
        : scope !== undefined
          ? createScopedFileSystem(rawBackend, scope)
          : rawBackend;
    return {
      backend,
      operations,
      mountDescriptions: [],
      transport: undefined,
      runtimeMountMutationsSupported: false,
      backendActiveRoot: undefined,
    };
  }

  const options = config?.options;

  // Local bridge transport — async subprocess setup + auth wiring.
  // If the caller explicitly set transport:"local", validate and fail fast
  // rather than silently falling through to the HTTP nexus path.
  const isExplicitLocalBridge =
    typeof options === "object" &&
    options !== null &&
    (options as Record<string, unknown>).transport === "local";
  const localBridgeParsed = parseLocalBridgeOptions(options);
  if (isExplicitLocalBridge && !localBridgeParsed.ok) {
    throw new Error(localBridgeParsed.error);
  }
  if (localBridgeParsed.ok) {
    const options = localBridgeParsed.value; // validated — overrides outer `options`
    const transport = await createLocalTransport({
      mountUri: options.mountUri,
      pythonPath: options.pythonPath,
      startupTimeoutMs: options.startupTimeoutMs,
      callTimeoutMs: options.callTimeoutMs,
      authTimeoutMs: options.authTimeoutMs,
      env: options.env,
    });

    // If backend construction fails, close the already-started subprocess to
    // avoid leaking it. Without this try/catch, any error below this point
    // (e.g. invalid mountPoint validation) would orphan the bridge process.
    let nexusBackend: ReturnType<typeof createNexusFileSystem>;
    let unsubscribe: () => void;
    let mutationsSupported = false;
    // Local-bridge mount-point selection. Three cases:
    //   1. Operator set `options.mountPoint` explicitly  → use it as-is
    //      (operator opted in, including `""` for namespace-root multi-mount).
    //   2. Single bridge mount, no explicit option       → infer that mount
    //      (legacy compat: bare `/foo.txt` resolves under the mount).
    //   3. Multi mount, no explicit option               → namespace-root (`""`)
    //      so callers must address mounts via their full paths.
    // We always pass an explicit mountPoint to createNexusFileSystem here —
    // never fall through to its default, which is `"fs"` (intended for HTTP
    // Nexus servers, not the local bridge).
    const transportMounts = transport.mounts ?? [];
    const inferredMountPoint =
      options.mountPoint ?? (transportMounts.length === 1 ? transportMounts[0] : undefined);
    const effectiveMountPoint = inferredMountPoint ?? "";
    try {
      unsubscribe = onNotification !== undefined ? transport.subscribe(onNotification) : () => {};
      nexusBackend = createNexusFileSystem({
        url: "local://bridge",
        transport,
        mountPoint: effectiveMountPoint,
      });
      // The backend root is fixed at construction time. If we inferred a
      // single-mount root (legacy compat) the operator must not /mount or
      // /unmount at runtime — those would leave the backend pointing at a
      // stale path. Only when the operator opted in to namespace-root
      // (explicit empty mountPoint) or set an explicit mountPoint can we
      // safely allow runtime mutations.
      mutationsSupported = options.mountPoint !== undefined || transportMounts.length !== 1;
    } catch (e: unknown) {
      transport.close();
      throw e;
    }

    // Wrap dispose to clean up the subscription and transport subprocess
    const nexusWrapped: FileSystemBackend = {
      ...nexusBackend,
      name: `nexus-local:${Array.isArray(options.mountUri) ? options.mountUri.join(",") : options.mountUri}`,
      dispose: async (): Promise<void> => {
        unsubscribe();
        try {
          await nexusBackend.dispose?.();
        } finally {
          // Always close the subprocess even if backend disposal rejects,
          // to prevent orphaned bridge processes on error paths.
          transport.close();
        }
      },
    };
    const backend =
      globScope !== undefined
        ? createScopedFs(nexusWrapped, globScope)
        : scope !== undefined
          ? createScopedFileSystem(nexusWrapped, scope)
          : nexusWrapped;
    // Wrap the transport so any caller of removeMount (TUI handler, future
    // tools, programmatic use) is structurally prevented from unmounting the
    // backend's active root. The backend root is fixed at construction time
    // and unmounting it would strand the session — defense-in-depth beyond
    // the TUI-level guard.
    // Build the set of mount paths whose removal would strand the session:
    //   - the inferred backend root (if any)
    //   - the scoped-fs root (if filesystem.options.root is set)
    //   - glob scope `allow` static prefixes
    // Unmounting any of these paths OR an ancestor of them would leave the
    // session resolving operations into a mount that no longer exists.
    const protectedRoots: string[] = [];
    if (inferredMountPoint !== undefined) protectedRoots.push(inferredMountPoint);
    if (scope !== undefined) protectedRoots.push(scope.root);
    if (globScope !== undefined) {
      for (const pattern of globScope.allow) {
        const wildcardIdx = pattern.search(/[*?]/);
        const staticPrefix = wildcardIdx === -1 ? pattern : pattern.slice(0, wildcardIdx);
        if (staticPrefix.length > 0) protectedRoots.push(staticPrefix);
      }
    }
    const isPathProtectedByUnmount = (path: string): boolean => {
      for (const root of protectedRoots) {
        if (path === root) return true;
        // Unmounting an ancestor of a protected root strands it just like
        // unmounting the root itself.
        if (root.startsWith(`${path}/`)) return true;
      }
      return false;
    };
    // addMount must reject targets that overlay or fall under any protected
    // root: a new mount at e.g. `/local/ws` (active backend root) or
    // `/local/ws/sub` (under a scope.root) would silently redirect already-
    // approved paths through the new connector, breaking the trust boundary.
    // Reject equality and any descendant relationship to a protected root.
    const isPathProtectedByMount = (target: string): boolean => {
      for (const root of protectedRoots) {
        if (target === root) return true;
        if (target.startsWith(`${root}/`)) return true;
        // Mounting an ancestor would also shadow the protected subtree.
        if (root.startsWith(`${target}/`)) return true;
      }
      return false;
    };
    const guardedTransport: import("@koi/fs-nexus").NexusTransport =
      ((): import("@koi/fs-nexus").NexusTransport => {
        if (protectedRoots.length === 0) return transport;
        const innerRemove = transport.removeMount;
        const innerAdd = transport.addMount;
        const wrapped: Record<string, unknown> = { ...transport };
        if (innerRemove !== undefined) {
          wrapped.removeMount = async (path: string) => {
            if (isPathProtectedByUnmount(path)) {
              return {
                ok: false,
                error: {
                  code: "VALIDATION",
                  message: `Cannot unmount ${path}: it (or a descendant) is an active filesystem root for this session and removing it would strand the backend on a dead mount.`,
                  retryable: RETRYABLE_DEFAULTS.VALIDATION,
                },
              };
            }
            return innerRemove(path);
          };
        }
        if (innerAdd !== undefined) {
          wrapped.addMount = async (uri: string, at?: string | undefined) => {
            // Pre-commit guard for the explicit `at` case.
            if (typeof at === "string" && isPathProtectedByMount(at)) {
              return {
                ok: false,
                error: {
                  code: "VALIDATION",
                  message: `Cannot mount at ${at}: that path overlays an active filesystem root for this session, which would silently redirect already-approved paths through the new connector.`,
                  retryable: RETRYABLE_DEFAULTS.VALIDATION,
                },
              };
            }
            const result = await innerAdd(uri, at);
            if (!result.ok) return result;
            // Post-commit verification: when `at` was omitted the bridge
            // picked the path. If it landed on (or under, or above) a
            // protected root, attempt to roll back via removeMount and
            // surface a structural error. We deliberately call the
            // INNER removeMount so the outer guard doesn't block the
            // rollback. If rollback itself fails, fall through with a
            // strong warning — the operator must intervene.
            const committed = result.value.path;
            if (
              committed !== "" &&
              result.value.pathUnknown !== true &&
              isPathProtectedByMount(committed)
            ) {
              // removeMount returns a Result (never throws on a Nexus error);
              // we MUST inspect rollback.ok before claiming success or the
              // shadowing mount stays live with the operator told otherwise.
              let rolledBack = false;
              let rollbackMessage = "rollback unavailable (removeMount unsupported)";
              if (innerRemove !== undefined) {
                try {
                  const rollback = await innerRemove(committed);
                  if (rollback.ok) {
                    rolledBack = true;
                  } else {
                    rollbackMessage = `rollback failed: ${rollback.error.message}`;
                  }
                } catch (e: unknown) {
                  rollbackMessage = `rollback threw: ${e instanceof Error ? e.message : String(e)}`;
                }
              }
              if (rolledBack) {
                return {
                  ok: false,
                  error: {
                    code: "VALIDATION",
                    message: `Mount at ${committed} rejected: it overlays an active filesystem root for this session. The bridge mount has been rolled back; verify with /mounts.`,
                    retryable: RETRYABLE_DEFAULTS.VALIDATION,
                  },
                };
              }
              return {
                ok: false,
                error: {
                  code: "INTERNAL",
                  message: `Mount at ${committed} overlays an active filesystem root and rollback was unsuccessful (${rollbackMessage}). The mount may still be live — run /mounts and manually /unmount ${committed} (from outside the protected scope) to repair state.`,
                  retryable: RETRYABLE_DEFAULTS.INTERNAL,
                },
              };
            }
            return result;
          };
        }
        Object.defineProperty(wrapped, "mounts", {
          enumerable: true,
          get(): readonly string[] {
            return transport.mounts ?? [];
          },
        });
        return wrapped as unknown as import("@koi/fs-nexus").NexusTransport;
      })();
    return {
      backend,
      operations,
      mountDescriptions: seedManifestMountDescriptions(transport),
      transport: guardedTransport,
      runtimeMountMutationsSupported: mutationsSupported,
      backendActiveRoot: inferredMountPoint,
    };
  }

  // Nexus HTTP transport — synchronous resolution
  const validated = validateNexusFileSystemConfig(options ?? {});
  if (!validated.ok) {
    throw new Error(`Invalid nexus filesystem config: ${validated.error.message}`);
  }
  const nexusHttpBackend = createNexusFileSystem(validated.value);
  const backend =
    globScope !== undefined
      ? createScopedFs(nexusHttpBackend, globScope)
      : scope !== undefined
        ? createScopedFileSystem(nexusHttpBackend, scope)
        : nexusHttpBackend;
  return {
    backend,
    operations,
    mountDescriptions: [],
    transport: undefined,
    runtimeMountMutationsSupported: false,
    backendActiveRoot: undefined,
  };
}
