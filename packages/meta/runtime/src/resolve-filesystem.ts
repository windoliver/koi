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

/**
 * Normalize a Nexus mount path to a canonical form: exactly one leading
 * slash, no trailing slash, empty input → empty string. The Nexus backend
 * itself strips leading/trailing slashes when computing its base path, so
 * comparisons in protected-root/active-root logic must canonicalize first
 * — otherwise `mountPoint: "gmail"` (a valid config) and the live mount
 * path `/gmail` would not match and the guard would be bypassed.
 */
function canonicalizeMountPath(value: string): string {
  if (value.length === 0) return "";
  const stripped = value.replace(/^\/+/, "").replace(/\/+$/, "");
  return stripped.length === 0 ? "" : `/${stripped}`;
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
 *
 * If `scopePaths` is provided (canonicalized protected/scope roots), the
 * seed is filtered so only mounts that fall within at least one of those
 * paths are surfaced. This prevents a scope-restricted session from
 * disclosing the existence of sibling mounts (other accounts, tenants,
 * unrelated workspaces) to the model via the system prompt — even though
 * the filesystem wrappers would block I/O, the trust boundary is already
 * breached once those names enter the privileged prompt layer.
 */
function seedManifestMountDescriptions(
  transport: import("@koi/fs-nexus").NexusTransport,
  scopePaths?: readonly string[] | undefined,
): readonly MountDescription[] {
  const mounts = transport.mounts ?? [];
  const filtered =
    scopePaths === undefined || scopePaths.length === 0
      ? mounts
      : mounts.filter((mountPath) => {
          const canonical = canonicalizeMountPath(mountPath);
          return scopePaths.some(
            (scopePath) =>
              canonical === scopePath ||
              canonical.startsWith(`${scopePath}/`) ||
              // The scope is *under* the mount: reading still works (scoped
              // wrapper caps it), so disclose the mount.
              scopePath.startsWith(`${canonical}/`),
          );
        });
  return [...filtered.map(cheapMountDescription)].sort((a, b) => a.path.localeCompare(b.path));
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
  /**
   * Canonicalized protected/scope paths for this session, or undefined when
   * the session has no disclosure boundary. Pass to
   * `mountDescriptionsState.setScope()` so /mount and /mounts updates obey
   * the same disclosure boundary applied at startup-seed.
   */
  readonly effectiveScopePaths: readonly string[] | undefined;
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
      effectiveScopePaths: undefined,
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
      // Policy gate: a session whose filesystem operations are read-only
      // must not be able to add or remove mounts, since /mount can attach
      // new connectors that widen what data becomes readable through
      // approved paths and /unmount can tear down a tenant's mounts.
      // Topology mutation is not exempt from the session's write
      // restrictions. When `operations` is set and excludes "write" and
      // "edit", refuse runtime mount mutations.
      if (operations !== undefined) {
        const writable = operations.includes("write") || operations.includes("edit");
        if (!writable) {
          mutationsSupported = false;
        }
      }
      // Defense-in-depth: if any scope (root or glob-allow) is configured
      // but the resolver cannot derive at least one concrete protected
      // namespace prefix for it, the addMount/removeMount guards have
      // nothing to enforce. Refuse runtime mutations entirely in that
      // case rather than silently allowing unguarded mounts to overlay
      // wildcard-scoped paths. (Computed below once protectedRoots is built.)
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
    // Every protected-root entry is canonicalized (leading slash, no
    // trailing slash) so comparisons against incoming mount paths match
    // regardless of whether the operator wrote `mountPoint: "gmail"` or
    // `mountPoint: "/gmail"`. Without this, a slashless explicit
    // mountPoint silently bypasses the unmount/addMount guards.
    const canonicalActiveRoot =
      inferredMountPoint === undefined ? undefined : canonicalizeMountPath(inferredMountPoint);
    const protectedRoots: string[] = [];
    if (canonicalActiveRoot !== undefined && canonicalActiveRoot.length > 0) {
      protectedRoots.push(canonicalActiveRoot);
    }
    if (scope !== undefined) {
      const scopeCanonical = canonicalizeMountPath(scope.root);
      if (scopeCanonical.length > 0) protectedRoots.push(scopeCanonical);
    }
    let hasUnprotectableScope = false;
    if (globScope !== undefined) {
      for (const pattern of globScope.allow) {
        const wildcardIdx = pattern.search(/[*?]/);
        const staticPrefix = wildcardIdx === -1 ? pattern : pattern.slice(0, wildcardIdx);
        const canonical = canonicalizeMountPath(staticPrefix);
        if (canonical.length > 0) {
          protectedRoots.push(canonical);
        } else {
          // Wildcard-only allow pattern (e.g. "**/*.md", "*.txt") cannot be
          // reduced to a static namespace, so the addMount/removeMount
          // guards have nothing to enforce. Mark the session as having an
          // unprotectable scope so we can fail-close runtime mutations.
          hasUnprotectableScope = true;
        }
      }
    }
    if (hasUnprotectableScope) {
      // Fail-closed: a glob-scoped session whose patterns lack a static
      // prefix cannot prove that a runtime /mount won't overlay an
      // already-approved path. Disable runtime mount mutations entirely
      // until the operator sets a stable scope.
      mutationsSupported = false;
    }
    const isPathProtectedByUnmount = (rawPath: string): boolean => {
      const path = canonicalizeMountPath(rawPath);
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
    const isPathProtectedByMount = (rawTarget: string): boolean => {
      const target = canonicalizeMountPath(rawTarget);
      for (const root of protectedRoots) {
        if (target === root) return true;
        if (target.startsWith(`${root}/`)) return true;
        // Mounting an ancestor would also shadow the protected subtree.
        if (root.startsWith(`${target}/`)) return true;
      }
      return false;
    };
    // Overlap check against an authoritative live-mount snapshot. Even when
    // `protectedRoots` is empty (e.g. namespace-root sessions with no scope),
    // mounting at, over, or under an *existing* live mount silently shadows
    // already-approved routing. Reject equality and any ancestor/descendant
    // relationship; return the offending live mount path for the error
    // message, or undefined when no overlap exists.
    const overlapsExistingMount = (
      rawTarget: string,
      liveMounts: Iterable<string>,
    ): string | undefined => {
      const target = canonicalizeMountPath(rawTarget);
      for (const m of liveMounts) {
        const live = canonicalizeMountPath(m);
        if (live.length === 0) continue;
        if (target === live) return live;
        if (target.startsWith(`${live}/`)) return live;
        if (live.startsWith(`${target}/`)) return live;
      }
      return undefined;
    };
    // Scope-aware visibility check. The guardedTransport operates on the
    // RAW bridge transport (created before scope wrapping), so pre/post
    // listMounts() calls return the raw mount table. To prevent a scoped
    // session from (a) probing or unmounting sibling mounts, or (b)
    // adding mounts outside its visible namespace, we filter all
    // mutation targets and overlap candidates against the session's
    // scope. `protectedRoots` already encodes the scope (active backend
    // root, scope.root, glob static prefixes) — re-use it as the
    // visibility filter. When protectedRoots is empty there is no scope
    // restriction (namespace-root + no scope), so every path is visible.
    const isPathVisibleInScope = (rawPath: string): boolean => {
      if (protectedRoots.length === 0) return true;
      const path = canonicalizeMountPath(rawPath);
      for (const root of protectedRoots) {
        if (path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`)) {
          return true;
        }
      }
      return false;
    };
    // Quarantine flag: set when addMount commits a mutation we cannot prove
    // is safe (e.g. pathUnknown + listMounts verification fails) AND best-
    // effort rollback could not confirm cleanup. While quarantined, all
    // subsequent add/remove mutations are refused so callers cannot continue
    // operating against a transport whose mount routing is in an unknown
    // state. Lifted only when the operator restarts the session.
    let transportQuarantined = false;
    let quarantineReason = "";
    // Per-session mutation lock. Concurrent /mount and /unmount must not
    // interleave their pre/post listMounts diffs, otherwise one request can
    // observe the other's newly added path as a "candidate" and roll it
    // back. Chain every mutation through a single FIFO promise queue so
    // verification and rollback always run against a stable mount set.
    let mutationLock: Promise<unknown> = Promise.resolve();
    function serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
      const next = mutationLock.then(fn, fn);
      mutationLock = next.catch(() => undefined);
      return next;
    }
    const guardedTransport: import("@koi/fs-nexus").NexusTransport =
      ((): import("@koi/fs-nexus").NexusTransport => {
        const innerRemove = transport.removeMount;
        const innerAdd = transport.addMount;
        // Nothing to guard if the transport exposes neither mutation. The
        // wrapper is otherwise unconditional: even when `protectedRoots` is
        // empty (namespace-root + no scope), addMount still needs to refuse
        // overlap with existing live mounts so a runtime /mount cannot
        // shadow an already-approved routing path.
        if (innerAdd === undefined && innerRemove === undefined) return transport;
        const wrapped: Record<string, unknown> = { ...transport };
        if (innerRemove !== undefined) {
          const removeImpl = async (path: string) => {
            if (transportQuarantined) {
              return {
                ok: false,
                error: {
                  code: "INTERNAL",
                  message: `Mount mutations are quarantined for this session: ${quarantineReason}`,
                  retryable: RETRYABLE_DEFAULTS.INTERNAL,
                },
              };
            }
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
            // Scope check: a scoped session must not be able to unmount
            // a sibling/tenant mount it can't even see. The scope-aware
            // bridge enforces this server-side; this is defense-in-depth
            // and gives the operator a clearer error than a bridge fault.
            if (!isPathVisibleInScope(path)) {
              return {
                ok: false,
                error: {
                  code: "VALIDATION",
                  message: `Cannot unmount ${path}: path is outside this session's scope.`,
                  retryable: RETRYABLE_DEFAULTS.VALIDATION,
                },
              };
            }
            return innerRemove(path);
          };
          wrapped.removeMount = (path: string) => serializeMutation(() => removeImpl(path));
        }
        if (innerAdd !== undefined) {
          const addImpl = async (uri: string, at?: string | undefined) => {
            if (transportQuarantined) {
              return {
                ok: false,
                error: {
                  code: "INTERNAL",
                  message: `Mount mutations are quarantined for this session: ${quarantineReason}`,
                  retryable: RETRYABLE_DEFAULTS.INTERNAL,
                },
              };
            }
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
            // Scope check: refuse `at` values outside the session's scope
            // so a scoped session can't add mounts in sibling tenants /
            // namespaces. Defense-in-depth alongside the scope-aware bridge.
            if (typeof at === "string" && !isPathVisibleInScope(at)) {
              return {
                ok: false,
                error: {
                  code: "VALIDATION",
                  message: `Cannot mount at ${at}: path is outside this session's scope.`,
                  retryable: RETRYABLE_DEFAULTS.VALIDATION,
                },
              };
            }
            // Authoritative pre-mutation snapshot. transport.mounts is a
            // local cache that can drift from the bridge — diffing against
            // a stale cache would let an existing mount get misclassified
            // as "newly added" and unmounted by the rollback below, or
            // miss a real overlap (silent shadow mount). When the transport
            // exposes listMounts, fail closed on its failure: the cache is
            // not a safe substitute for safety-critical overlap decisions.
            // When the transport has no listMounts at all, the cache is
            // the only available state — accept it but the post-commit
            // rollback path is also gated on listMounts so the failure
            // mode is still bounded.
            let preMounts: Set<string>;
            if (transport.listMounts !== undefined) {
              const preList = await transport.listMounts();
              if (!preList.ok) {
                return {
                  ok: false,
                  error: {
                    code: "INTERNAL",
                    message: `Cannot validate mount of ${uri}: pre-commit listMounts failed (${preList.error.message}). Refusing to mutate without authoritative state — the optimistic cache may be stale and could miss an overlap with an existing live mount.`,
                    retryable: RETRYABLE_DEFAULTS.INTERNAL,
                  },
                };
              }
              preMounts = new Set(preList.value);
            } else {
              preMounts = new Set(transport.mounts ?? []);
            }
            // Pre-commit overlap guard against existing live mounts. Runs
            // even when `protectedRoots` is empty (e.g. namespace-root + no
            // scope) so a runtime /mount cannot shadow an already-approved
            // mount by overlaying its path or an ancestor/descendant.
            if (typeof at === "string") {
              const overlap = overlapsExistingMount(at, preMounts);
              if (overlap !== undefined) {
                // Redact out-of-scope mount paths from the error message:
                // probing candidate `at` values would otherwise enumerate
                // hidden sibling/tenant mounts via the "overlaps X" channel.
                const overlapVisible = isPathVisibleInScope(overlap);
                return {
                  ok: false,
                  error: {
                    code: "VALIDATION",
                    message: overlapVisible
                      ? `Cannot mount at ${at}: it overlaps existing live mount ${overlap}; remove the existing mount first or choose a non-overlapping path.`
                      : `Cannot mount at ${at}: it overlaps a mount outside this session's scope.`,
                    retryable: RETRYABLE_DEFAULTS.VALIDATION,
                  },
                };
              }
            }
            const result = await innerAdd(uri, at);
            if (!result.ok) return result;
            // pathUnknown branch: the bridge committed the mutation but
            // could not isolate the resulting path. We MUST NOT accept this
            // as "merely a refresh prompt" when protected roots exist —
            // the new mount could be shadowing one of them silently. Do
            // an authoritative listMounts diff against preMounts; for any
            // newly-introduced path that overlays a protected root, attempt
            // rollback and fail closed.
            if (result.value.pathUnknown === true || result.value.path === "") {
              if (transport.listMounts !== undefined) {
                const listed = await transport.listMounts();
                if (!listed.ok) {
                  // Cannot verify safety. The bridge committed *something* and
                  // we have no authoritative way to know if it overlays a
                  // protected root. We do NOT attempt URI-based rollback: the
                  // NexusTransport contract advertises removeMount(path), not
                  // URI removal, so calling innerRemove(uri) targets an
                  // identifier that may not name the committed mount at all
                  // and could mis-remove an unrelated path or no-op while we
                  // claim cleanup. Quarantine and require operator recovery.
                  transportQuarantined = true;
                  quarantineReason = `addMount(${uri}) returned pathUnknown and listMounts verification failed (${listed.error.message}); rollback is not safely targetable from a URI. Run /mounts after restart and manually /unmount any offending paths.`;
                  return {
                    ok: false,
                    error: {
                      code: "INTERNAL",
                      message: quarantineReason,
                      retryable: RETRYABLE_DEFAULTS.INTERNAL,
                    },
                  };
                }
                const candidates = listed.value.filter((p) => !preMounts.has(p));
                // Fail-closed on ambiguous post-state: pathUnknown + an
                // unchanged mount set means the bridge committed a mutation
                // we cannot localize to any new path. The most dangerous
                // interpretation — that the backend resolved the URI onto an
                // already-existing live/protected mount and silently replaced
                // its routing — is indistinguishable from a benign no-op
                // here, so we must refuse to confirm success. Quarantine and
                // require operator recovery rather than handing the caller a
                // pathUnknown payload that the TUI would treat as "merely a
                // refresh prompt".
                if (candidates.length === 0) {
                  transportQuarantined = true;
                  quarantineReason = `addMount(${uri}) returned pathUnknown but post-mutation listMounts is unchanged; cannot prove the new mount did not replace an existing live or protected path. Run /mounts after restart and manually /unmount any offending paths.`;
                  return {
                    ok: false,
                    error: {
                      code: "INTERNAL",
                      message: quarantineReason,
                      retryable: RETRYABLE_DEFAULTS.INTERNAL,
                    },
                  };
                }
                // Two ways a candidate is "offending":
                // (1) it overlays a protected root (active backend / scope /
                //     glob-static-prefix), or
                // (2) it overlaps an existing live mount in the pre-mutation
                //     snapshot — required even when protectedRoots is empty
                //     so namespace-root sessions still reject silent shadow
                //     mounts onto already-approved paths.
                const offending = candidates.filter(
                  (p) =>
                    isPathProtectedByMount(p) || overlapsExistingMount(p, preMounts) !== undefined,
                );
                if (offending.length > 0) {
                  const rollbackErrors: string[] = [];
                  if (innerRemove !== undefined) {
                    for (const p of offending) {
                      // Defense-in-depth: even though `p` was diffed against
                      // an authoritative pre-mount snapshot, refuse to roll
                      // back any path that the unmount guard considers
                      // protected. A misclassification under transient list
                      // drift would otherwise be allowed to remove a real
                      // protected root and strand the session.
                      if (isPathProtectedByUnmount(p)) {
                        rollbackErrors.push(`${p}: refused rollback — path is itself protected`);
                        continue;
                      }
                      try {
                        const rb = await innerRemove(p);
                        if (!rb.ok) rollbackErrors.push(`${p}: ${rb.error.message}`);
                      } catch (e: unknown) {
                        rollbackErrors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
                      }
                    }
                  }
                  if (rollbackErrors.length === 0) {
                    return {
                      ok: false,
                      error: {
                        code: "VALIDATION",
                        message: `Mount of ${uri} rejected: it landed on protected root(s) ${offending.join(", ")}. Bridge mount(s) rolled back; verify with /mounts.`,
                        retryable: RETRYABLE_DEFAULTS.VALIDATION,
                      },
                    };
                  }
                  // Rollback refused or failed → quarantine. Continuing to
                  // accept mutations against routing state that may include
                  // a live shadowing mount is the failure mode this code
                  // exists to prevent.
                  transportQuarantined = true;
                  quarantineReason = `addMount(${uri}) landed on protected root(s) ${offending.join(", ")} and rollback was unsuccessful (${rollbackErrors.join("; ")}). Restart the session to recover.`;
                  return {
                    ok: false,
                    error: {
                      code: "INTERNAL",
                      message: `Mount of ${uri} landed on protected root(s) and rollback was unsuccessful (${rollbackErrors.join("; ")}). The mount may still be live — run /mounts and manually /unmount the offending paths from outside the protected scope to repair state. Further mount mutations are now quarantined for this session.`,
                      retryable: RETRYABLE_DEFAULTS.INTERNAL,
                    },
                  };
                }
              }
              // No protected roots, OR no overlay detected → forward the
              // pathUnknown payload upstream so the TUI can prompt /mounts.
              return result;
            }
            const committed = result.value.path;
            // Post-commit overlap check against the pre-mutation live-mount
            // snapshot. Catches the case where the bridge resolved the URI
            // to a path that overlaps an existing mount (e.g. operator
            // omitted `at` and the connector landed on a colliding default).
            // Mirrors the protected-root rollback flow but uses the broader
            // overlap predicate so namespace-root sessions are also covered.
            if (committed !== "" && !isPathProtectedByMount(committed)) {
              const overlap = overlapsExistingMount(committed, preMounts);
              if (overlap !== undefined) {
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
                const overlapVisible = isPathVisibleInScope(overlap);
                if (rolledBack) {
                  return {
                    ok: false,
                    error: {
                      code: "VALIDATION",
                      message: overlapVisible
                        ? `Mount at ${committed} rejected: it overlaps existing live mount ${overlap}. Bridge mount rolled back; verify with /mounts.`
                        : `Mount at ${committed} rejected: it overlaps a mount outside this session's scope. Bridge mount rolled back.`,
                      retryable: RETRYABLE_DEFAULTS.VALIDATION,
                    },
                  };
                }
                transportQuarantined = true;
                quarantineReason = overlapVisible
                  ? `addMount committed at ${committed} overlapping existing mount ${overlap} and rollback failed (${rollbackMessage}). Restart the session to recover.`
                  : `addMount committed at ${committed} overlapping an out-of-scope mount and rollback failed (${rollbackMessage}). Restart the session to recover.`;
                return {
                  ok: false,
                  error: {
                    code: "INTERNAL",
                    message: overlapVisible
                      ? `Mount at ${committed} overlaps existing mount ${overlap} and rollback was unsuccessful (${rollbackMessage}). The mount may still be live — run /mounts and manually /unmount ${committed} to repair state. Further mount mutations are now quarantined for this session.`
                      : `Mount at ${committed} overlaps an out-of-scope mount and rollback was unsuccessful (${rollbackMessage}). Further mount mutations are now quarantined for this session.`,
                    retryable: RETRYABLE_DEFAULTS.INTERNAL,
                  },
                };
              }
            }
            if (committed !== "" && isPathProtectedByMount(committed)) {
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
              transportQuarantined = true;
              quarantineReason = `addMount committed at protected path ${committed} and rollback failed (${rollbackMessage}). Restart the session to recover.`;
              return {
                ok: false,
                error: {
                  code: "INTERNAL",
                  message: `Mount at ${committed} overlays an active filesystem root and rollback was unsuccessful (${rollbackMessage}). The mount may still be live — run /mounts and manually /unmount ${committed} (from outside the protected scope) to repair state. Further mount mutations are now quarantined for this session.`,
                  retryable: RETRYABLE_DEFAULTS.INTERNAL,
                },
              };
            }
            return result;
          };
          wrapped.addMount = (uri: string, at?: string | undefined) =>
            serializeMutation(() => addImpl(uri, at));
        }
        // Scope-filter listMounts and describeMount in the TS wrapper.
        // The bridge's _list_mounts_scoped relies on a Python-side scoped
        // wrapper that does not exist in this build (the bridge constructs
        // `fs` from raw nexus.fs.mount), so the ONLY enforcement of TS-side
        // scope across these RPCs lives here. Without this wrapper a
        // scoped session could enumerate every live mount via listMounts
        // or fetch README content for sibling mounts via describeMount.
        const innerListMounts = transport.listMounts;
        if (innerListMounts !== undefined && protectedRoots.length > 0) {
          wrapped.listMounts = async (): Promise<
            Result<readonly string[], import("@koi/core").KoiError>
          > => {
            const raw = await innerListMounts();
            if (!raw.ok) return raw;
            return { ok: true, value: raw.value.filter(isPathVisibleInScope) };
          };
        }
        const innerDescribeMount = transport.describeMount;
        if (innerDescribeMount !== undefined && protectedRoots.length > 0) {
          wrapped.describeMount = async (
            path: string,
          ): Promise<Result<MountDescription, import("@koi/core").KoiError>> => {
            if (!isPathVisibleInScope(path)) {
              return {
                ok: false,
                error: {
                  code: "VALIDATION",
                  message: `Cannot describe mount ${path}: path is outside this session's scope.`,
                  retryable: RETRYABLE_DEFAULTS.VALIDATION,
                },
              };
            }
            return innerDescribeMount(path);
          };
        }
        Object.defineProperty(wrapped, "mounts", {
          enumerable: true,
          get(): readonly string[] {
            const raw = transport.mounts ?? [];
            if (protectedRoots.length === 0) return raw;
            return raw.filter(isPathVisibleInScope);
          },
        });
        return wrapped as unknown as import("@koi/fs-nexus").NexusTransport;
      })();
    // Sentinel "scope" that no real mount path can match. When a session has
    // a glob scope whose patterns lack any static prefix
    // (`hasUnprotectableScope`), we cannot prove which sibling mounts the
    // operator intended to hide. Fail closed: emit no manifest mount entries
    // and hand the middleware a sentinel scope so any /mounts refresh that
    // tries to add runtime entries also drops them.
    const UNPROTECTABLE_SCOPE_SENTINEL = "/__koi_unprotectable_scope_no_disclosure__";
    const seedMounts = hasUnprotectableScope
      ? []
      : seedManifestMountDescriptions(transport, protectedRoots);
    const seedScope = hasUnprotectableScope
      ? [UNPROTECTABLE_SCOPE_SENTINEL]
      : protectedRoots.length > 0
        ? protectedRoots
        : undefined;
    return {
      backend,
      operations,
      // Pass protectedRoots as the disclosure scope so a scoped session
      // does not leak sibling mount paths into the system prompt. When
      // protectedRoots is empty AND the scope is fully static (no
      // unprotectable wildcards), the seed includes all mounts (no scope
      // configured → no filtering needed). Wildcard-only scopes get the
      // sentinel above, which filters every entry out.
      mountDescriptions: seedMounts,
      effectiveScopePaths: seedScope,
      transport: guardedTransport,
      runtimeMountMutationsSupported: mutationsSupported,
      backendActiveRoot: canonicalActiveRoot,
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
    effectiveScopePaths: undefined,
  };
}
