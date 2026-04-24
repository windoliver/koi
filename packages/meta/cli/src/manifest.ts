/**
 * Minimal agent manifest loader for #1264.
 *
 * Loads a YAML manifest file and extracts the fields needed for basic
 * agent customization: model name, behavioral instructions, opt-in
 * preset stacks, and opt-in plugins.
 *
 * Intentionally minimal — full AgentManifest assembly is out of scope.
 *
 * Manifest format (koi.yaml):
 *   name: my-agent          # optional, informational
 *   model:
 *     name: google/gemini-2.0-flash-001
 *   instructions: |         # optional — injected as system prompt
 *     You are a helpful coding assistant.
 *   stacks:                 # optional — opt into a subset of preset stacks
 *     - notebook            #   (omit to activate every stack in DEFAULT_STACKS)
 *     - rules
 *     - skills
 *   plugins:                # optional — opt into a subset of discovered plugins
 *     - my-hook-bundle      #   (omit to activate every plugin in ~/.koi/plugins/)
 *     - my-mcp-server       #   (empty array disables every plugin)
 *   backgroundSubprocesses: true   # TUI ONLY — controls whether the execution
 *                                  #   stack exposes the `bash_background` tool
 *                                  #   (detached shell subprocess launch). The
 *                                  #   `task_*` coordinator tools are gated
 *                                  #   separately on whether the `spawn` preset
 *                                  #   stack is active — see the comment on
 *                                  #   `ManifestConfig.backgroundSubprocesses`
 *                                  #   below for the full contract. `koi tui`
 *                                  #   honors this field (default true).
 *                                  #   `koi start` REJECTS manifests that set
 *                                  #   it to `true` because the CLI's default
 *                                  #   loop detector hard-fails legitimate
 *                                  #   `task_output` polling of background
 *                                  #   jobs. Shared manifests that target both
 *                                  #   hosts must omit this field or split
 *                                  #   per-host.
 */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { loadConfig } from "@koi/config";
import type {
  ChildIsolation,
  ChildSpec,
  FileSystemConfig,
  RestartType,
  SupervisionConfig,
  SupervisionStrategy,
} from "@koi/core";
import { validateSupervisionConfig } from "@koi/core";
import { validateFileSystemConfig } from "@koi/runtime";

/**
 * Absolutize a `local://` mountUri against the manifest directory so relative
 * paths anchor to the manifest file, not the CLI shell cwd. Non-`local://`
 * URIs (nexus HTTP endpoints, gdrive://, s3://, etc.) are passed through
 * unchanged — only the local scheme has a filesystem-path semantic that can
 * silently retarget based on the launching shell.
 *
 * Examples (manifestDir = `/home/alice/repo-a`):
 *   `local://./workspace`           → `local:///home/alice/repo-a/workspace`
 *   `local://workspace`             → `local:///home/alice/repo-a/workspace`
 *   `local:///etc/config`           → `local:///etc/config` (already absolute)
 *   `gdrive://my-drive`             → `gdrive://my-drive` (not local)
 */
function absolutizeMountUri(mountUri: string, manifestDir: string): string {
  const prefix = "local://";
  if (!mountUri.startsWith(prefix)) return mountUri;
  const path = mountUri.slice(prefix.length);
  if (isAbsolute(path)) return mountUri;
  return `${prefix}${resolvePath(manifestDir, path)}`;
}

/**
 * Scheme allowlist for host-owned nexus local-bridge mounts (#1777).
 *
 * Only `local://` is supported today. Other nexus-fs connector schemes
 * (gdrive://, s3://, gmail://, etc.) require OAuth flows whose
 * `auth_required` notifications must be routed back to the user via
 * `transport.submitAuthCode(...)`, and neither `koi start` nor
 * `koi tui` has a channel-aware auth handler yet. Accepting those URIs
 * and letting them fail on first filesystem call would silently break
 * sessions mid-turn; rejecting them deterministically at parse time
 * gives the user a clear error before any adapter or subprocess is
 * created.
 */
const SUPPORTED_NEXUS_LOCAL_BRIDGE_SCHEMES: readonly string[] = ["local://"];

function isSupportedMountUri(uri: string): boolean {
  return SUPPORTED_NEXUS_LOCAL_BRIDGE_SCHEMES.some((s) => uri.startsWith(s));
}

/**
 * Walk `filesystem.options.mountUri` (string or array of strings) and
 * anchor every relative `local://` URI to the manifest directory.
 * Rebuilds a new `FileSystemConfig` (structural clone of the touched
 * fields) so the input stays immutable.
 */
function anchorFilesystemPaths(config: FileSystemConfig, manifestDir: string): FileSystemConfig {
  const options = config.options;
  if (options === undefined || typeof options !== "object") return config;
  const opts = options as Record<string, unknown>;

  // Anchor mountUri relative paths to manifest directory
  let nextMountUri: unknown = opts.mountUri;
  const mountUri = opts.mountUri;
  if (typeof mountUri === "string") {
    nextMountUri = absolutizeMountUri(mountUri, manifestDir);
  } else if (Array.isArray(mountUri) && mountUri.every((u) => typeof u === "string")) {
    nextMountUri = (mountUri as string[]).map((u) => absolutizeMountUri(u, manifestDir));
  }

  // Anchor scope root to manifest directory so a relative root like
  // "./workspace" resolves against the manifest, not the shell cwd.
  let nextRoot: unknown = opts.root;
  if (typeof opts.root === "string" && !isAbsolute(opts.root)) {
    nextRoot = resolvePath(manifestDir, opts.root);
  }

  if (nextMountUri === opts.mountUri && nextRoot === opts.root) return config;
  return {
    ...config,
    options: { ...opts, mountUri: nextMountUri, root: nextRoot },
  };
}

/**
 * Names of core middleware layers that hosts configure via factory flags,
 * not via `manifest.middleware`. Users who name any of these in the zone-B
 * middleware list get a load-time error directing them to the host flag.
 *
 * This list covers three forms:
 *   1. Runtime middleware `.name` values (`permissions`, `hooks`, ...)
 *   2. Canonical workspace package names (`@koi/permissions`, ...)
 *   3. camelCase variants and short aliases in case of typo tolerance
 *
 * All three forms are rejected because the runtime factory and YAML loader
 * both run this check against user-supplied entries. Extending the list
 * beyond the short name forms closes the gap an embedder might create by
 * naming a core layer by its package name when calling `createKoiRuntime`
 * programmatically — the security-critical layers in zone C stay out of
 * user reach regardless of the entry surface.
 */
export const CORE_MIDDLEWARE_BLOCKLIST: readonly string[] = [
  // Runtime middleware `.name` values.
  "hook",
  "hooks",
  "permissions",
  "exfiltration-guard",
  "exfiltrationGuard",
  "model-router",
  "modelRouter",
  "system-prompt",
  "systemPrompt",
  "session-transcript",
  "sessionTranscript",
  // Canonical workspace package names — embedders calling
  // `createKoiRuntime({ manifestMiddleware: [{ name: "@koi/permissions", ... }] })`
  // must also be rejected, not just YAML users.
  "@koi/permissions",
  "@koi/middleware-permissions",
  "@koi/hooks",
  "@koi/middleware-hooks",
  "@koi/middleware-exfiltration-guard",
  "@koi/exfiltration-guard",
  "@koi/model-router",
  "@koi/middleware-model-router",
  "@koi/system-prompt",
  "@koi/middleware-system-prompt",
  "@koi/session",
  "@koi/session-transcript",
  "@koi/middleware-session-transcript",
];

/**
 * A single entry in `manifest.middleware` (zone B). Users declare these
 * in order; the resolved chain preserves declared order within zone B.
 */
export interface ManifestMiddlewareEntry {
  readonly name: string;
  readonly options: Readonly<Record<string, unknown>> | undefined;
  readonly enabled: boolean;
}

export interface ManifestConfig {
  readonly modelName: string;
  readonly instructions: string | undefined;
  /**
   * Opt-in subset of preset stack ids. `undefined` means "activate every
   * stack in `DEFAULT_STACKS`" (v1's default posture). An empty array
   * means "deactivate every stack" (the host runs core middleware only).
   */
  readonly stacks: readonly string[] | undefined;
  /**
   * Zone B: ordered, user-controlled middleware list. Each entry names a
   * middleware registered in the `MiddlewareRegistry` and carries
   * optional `options` passed verbatim to the factory. `enabled: false`
   * excludes an entry without removing it from the manifest (useful for
   * A/B comparison and review diffs).
   *
   * Zone B entries CANNOT name any layer in `CORE_MIDDLEWARE_BLOCKLIST` —
   * core layers are configured via host flags, not the manifest. Zone B
   * always composes between zone A (preset stacks) and zone C (required
   * core); users cannot reorder across zones.
   *
   * `undefined` means "no zone B entries" — existing manifests that only
   * use `stacks` keep working unchanged.
   */
  readonly middleware: readonly ManifestMiddlewareEntry[] | undefined;
  /**
   * Opt-in subset of discovered plugin names. `undefined` means
   * "activate every plugin found in `~/.koi/plugins/`" — matches the
   * prior filesystem-scan auto-discovery behavior for hosts without a
   * `plugins:` field. An empty array means "deactivate every plugin"
   * — useful for reproducible CI assemblies.
   */
  readonly plugins: readonly string[] | undefined;
  /**
   * Whether the execution preset stack contributes the
   * `bash_background` tool (detached shell subprocess launch).
   *
   * This field controls ONLY `bash_background`. The `task_*`
   * coordinator tools (`task_create`, `task_list`, `task_output`,
   * `task_delegate`, `task_stop`, `task_update`, `task_get`) are
   * gated independently on whether the `spawn` preset stack is
   * active, because the task board is coordinator infrastructure —
   * sub-agent fan-out flows need `task_create` + `task_delegate`
   * and polling for results needs `task_output`. Hosts that
   * exclude `spawn` from their stack list (e.g. `koi start` via
   * `DEFAULT_STACKS_WITHOUT_SPAWN`) lose the `task_*` surface
   * regardless of this field's value.
   *
   * **TUI only.** `koi tui` defaults to `true` and honors explicit
   * settings. `koi start` REJECTS any manifest that sets this to
   * `true`, because the CLI's default loop detector hard-fails
   * legitimate `task_output` polling. Shared manifests that
   * target both hosts must omit this field (or split per-host).
   *
   * Invariant enforcement: because `bash_background` relies on
   * the task board for status/output observability, the factory
   * force-overrides this to `false` and emits a warning if the
   * caller requested `true` but `spawn` is excluded (task_* would
   * otherwise be missing). See `runtime-factory.ts`.
   */
  readonly backgroundSubprocesses: boolean | undefined;
  /**
   * Optional filesystem backend configuration. When set, the host
   * resolves it via `@koi/runtime`'s `resolveFileSystemAsync` (for
   * the nexus+local-bridge path) or `resolveFileSystem` (for
   * `backend: "local"` and plain nexus HTTP) and wires the resulting
   * FileSystemBackend into the core `fs_read`/`fs_write`/`fs_edit`
   * providers. When `undefined`, the host falls back to the default
   * local backend rooted at `cwd`. Malformed config (unknown backend,
   * missing `mountUri`, etc.) is rejected here so the CLI fails fast
   * before any adapter/subprocess is created.
   */
  readonly filesystem: FileSystemConfig | undefined;
  /**
   * Governance defaults (gov-10). Each field supplies a default for the
   * matching CLI flag (`--max-spend`, `--max-turns`, `--max-spawn-depth`,
   * `--policy-file`, `--alert-threshold`). CLI flags, when passed, win
   * over manifest values. `--no-governance` ignores this section entirely.
   *
   *   governance:
   *     maxSpend: 2.50
   *     maxTurns: 50
   *     maxSpawnDepth: 3
   *     policyFile: ./policies/default.yaml
   *     alertThresholds: [0.7, 0.9]
   */
  readonly governance: ManifestGovernanceConfig | undefined;
  /**
   * Optional supervision tree declaration. When present, the runtime
   * auto-activates the supervision subsystem (#1866) — children listed
   * here are spawned and restart-managed per the declared strategy.
   *
   *   supervision:
   *     strategy: { kind: one_for_one }
   *     maxRestarts: 5
   *     maxRestartWindowMs: 60000
   *     children:
   *       - name: worker-a
   *         restart: permanent
   *         isolation: in-process
   *
   * `undefined` means supervision is NOT activated for this manifest.
   * Shape-validated against `@koi/core`'s `validateSupervisionConfig`
   * at parse time so malformed configs fail fast.
   */
  readonly supervision: SupervisionConfig | undefined;
  /**
   * Optional audit sink configuration. Each field supplies a default for the
   * matching env var (`KOI_AUDIT_NDJSON`, `KOI_AUDIT_SQLITE`). Env vars, when
   * set, win over manifest values. Paths are anchored to the manifest directory.
   * Parent directories must already exist — audit sinks never silently create them.
   *
   *   audit:
   *     ndjson: ./logs/audit.ndjson
   *     sqlite: ./logs/audit.db
   *     violations: ./logs/violations.db
   */
  readonly audit: ManifestAuditConfig | undefined;
}

/**
 * Audit sink paths lifted from the manifest. Each field is the absolute path
 * (anchored to manifest dir at parse time) for the corresponding sink.
 * Precedence: env var → manifest → default (violations only).
 *
 * `present` is always `true` — indicates the `audit:` block was present in the
 * manifest even when all three sink fields are undefined (e.g. `audit: {}`).
 * Hosts use this to detect the block regardless of which fields were set.
 */
export interface ManifestAuditConfig {
  readonly present: true;
  /**
   * True when the audit block had an unrecognized shape in lenient mode:
   * unknown keys, wrong-type values at the block level, or a non-object.
   * The tui-command gate-off check uses this to emit a clear "fix the
   * manifest" error rather than requiring unrelated KOI_AUDIT_* overrides
   * for sinks the manifest author never intended to configure.
   */
  readonly malformed?: true;
  readonly ndjson: string | undefined;
  readonly sqlite: string | undefined;
  readonly violations: string | undefined;
}

/**
 * Governance defaults lifted from the manifest. Shapes mirror the CLI
 * `--max-*` / `--alert-threshold` flags so the merge step is a direct
 * field-by-field override. `policyFile` is anchored to the manifest's
 * directory so relative paths are not silently rebound to the CLI cwd
 * when a shared manifest is checked into a repo.
 */
export interface ManifestGovernanceConfig {
  readonly maxSpend: number | undefined;
  readonly maxTurns: number | undefined;
  readonly maxSpawnDepth: number | undefined;
  readonly policyFile: string | undefined;
  readonly alertThresholds: readonly number[] | undefined;
}

/**
 * Options for `loadManifestConfig`.
 */
export interface LoadManifestOptions {
  /**
   * When `true`, skip the OAuth-scheme allowlist check for nexus local-bridge
   * mounts. Pass this for hosts (like `koi tui`) that have an interactive auth
   * UI capable of routing `auth_required` notifications back to the user via
   * `transport.submitAuthCode(...)`. Hosts without an auth UI (like `koi start`)
   * keep the default `false` so OAuth-gated schemes fail fast at parse time.
   */
  readonly allowOAuthSchemes?: boolean | undefined;
  /**
   * When `true`, the `audit:` block is parsed leniently — block presence is
   * detected and the `present: true` marker is set, but field values and unknown
   * keys are NOT validated. Use this on hosts where the feature gate is off so a
   * malformed `audit:` stanza in a shared manifest cannot deny startup. Hosts
   * that actually wire audit sinks (where `KOI_ALLOW_MANIFEST_FILE_SINKS=1`)
   * must pass `false` (the default) so typos and invalid paths are caught early.
   */
  readonly skipAuditValidation?: boolean | undefined;
}

/**
 * Load a minimal agent manifest from a YAML or JSON file.
 *
 * Validates eagerly — call before creating any adapters so errors surface
 * before any API calls are made.
 *
 * Returns `{ ok: false, error }` for file-not-found, parse errors, or
 * missing required fields. Never throws.
 */
export async function loadManifestConfig(
  path: string,
  options?: LoadManifestOptions,
): Promise<
  | { readonly ok: true; readonly value: ManifestConfig }
  | { readonly ok: false; readonly error: string }
> {
  const result = await loadConfig(path);
  if (!result.ok) {
    return { ok: false, error: result.error.message };
  }

  const raw = result.value;

  const model = raw.model;
  if (typeof model !== "object" || model === null) {
    return {
      ok: false,
      error: "manifest.model is required — add:\n  model:\n    name: google/gemini-2.0-flash-001",
    };
  }

  const modelName = (model as Record<string, unknown>).name;
  if (typeof modelName !== "string" || modelName.trim().length === 0) {
    return {
      ok: false,
      error: "manifest.model.name is required and must be a non-empty string",
    };
  }

  const instructions = raw.instructions;
  if (instructions !== undefined && typeof instructions !== "string") {
    return {
      ok: false,
      error: "manifest.instructions must be a string (use a YAML block scalar: instructions: |)",
    };
  }

  const stacksRaw = raw.stacks;
  let stacks: readonly string[] | undefined;
  if (stacksRaw === undefined) {
    stacks = undefined;
  } else if (!Array.isArray(stacksRaw)) {
    return {
      ok: false,
      error: "manifest.stacks must be a list of stack ids, e.g. stacks: [notebook, rules, skills]",
    };
  } else {
    const invalid = stacksRaw.find((s) => typeof s !== "string" || s.length === 0);
    if (invalid !== undefined) {
      return {
        ok: false,
        error: "manifest.stacks entries must all be non-empty strings",
      };
    }
    stacks = stacksRaw as readonly string[];
  }

  const pluginsRaw = raw.plugins;
  let plugins: readonly string[] | undefined;
  if (pluginsRaw === undefined) {
    plugins = undefined;
  } else if (!Array.isArray(pluginsRaw)) {
    return {
      ok: false,
      error:
        "manifest.plugins must be a list of plugin names, e.g. plugins: [my-hook-bundle, my-mcp-server]",
    };
  } else {
    const invalid = pluginsRaw.find((s) => typeof s !== "string" || s.length === 0);
    if (invalid !== undefined) {
      return {
        ok: false,
        error: "manifest.plugins entries must all be non-empty strings",
      };
    }
    plugins = pluginsRaw as readonly string[];
  }

  const bgSubsRaw = raw.backgroundSubprocesses;
  let backgroundSubprocesses: boolean | undefined;
  if (bgSubsRaw === undefined) {
    backgroundSubprocesses = undefined;
  } else if (typeof bgSubsRaw !== "boolean") {
    return {
      ok: false,
      error:
        "manifest.backgroundSubprocesses must be a boolean (e.g. backgroundSubprocesses: true)",
    };
  } else {
    backgroundSubprocesses = bgSubsRaw;
  }

  const middlewareResult = parseManifestMiddleware(raw.middleware);
  if (!middlewareResult.ok) {
    return middlewareResult;
  }

  const governanceResult = parseManifestGovernance(raw.governance, path);
  if (!governanceResult.ok) {
    return governanceResult;
  }

  const supervisionResult = parseManifestSupervision(raw.supervision);
  if (!supervisionResult.ok) {
    return supervisionResult;
  }

  const auditResult = parseManifestAudit(raw.audit, path, options?.skipAuditValidation === true);
  if (!auditResult.ok) {
    return auditResult;
  }

  // `trustedHost` is not an accepted manifest field. Earlier
  // designs exposed a per-layer security opt-out surface here, but
  // the runtime factory never actually omitted the corresponding
  // middleware, so the API advertised behavior it did not provide.
  // The entire surface has been removed rather than ship a no-op.
  // Reject the field at the loader with a clear message so
  // existing manifests that tried to use it fail fast instead of
  // silently losing configuration.
  if (raw.trustedHost !== undefined) {
    return {
      ok: false,
      error:
        "manifest.trustedHost is not a supported field. The per-layer security opt-outs " +
        "(disablePermissions, disableExfiltrationGuard) that were previously documented here " +
        "were never wired into runtime assembly and have been removed. Hosts that need a " +
        "headless/CI posture without permissions or exfiltration-guard must construct the " +
        "runtime with a custom middleware list programmatically.",
    };
  }

  let filesystem: FileSystemConfig | undefined;
  const fsRaw = raw.filesystem;
  if (fsRaw !== undefined) {
    if (typeof fsRaw !== "object" || fsRaw === null || Array.isArray(fsRaw)) {
      return {
        ok: false,
        error: "manifest.filesystem must be an object with keys: backend, options, operations",
      };
    }
    const fsResult = validateFileSystemConfig(fsRaw);
    if (!fsResult.ok) {
      return {
        ok: false,
        error: `manifest.filesystem: ${fsResult.error.message}`,
      };
    }
    // Anchor relative `local://` mountUris to the manifest directory so
    // they do NOT silently retarget against the CLI shell cwd when a
    // shared manifest is checked into one repo and the command is
    // launched from another.
    const manifestDir = dirname(resolvePath(path));
    filesystem = anchorFilesystemPaths(fsResult.value, manifestDir);

    // Scheme allowlist (#1777 review round 7): reject OAuth-requiring
    // mountUri schemes deterministically at parse time rather than
    // silently accepting them and aborting the session on first
    // filesystem call. Routing `auth_required` notifications back
    // through `transport.submitAuthCode(...)` requires a channel-aware
    // auth handler. Hosts that wire OAuth support (koi tui with the
    // interactive auth loop) pass `allowOAuthSchemes: true` to skip
    // this check. Non-interactive hosts (koi start) keep the default
    // posture: local:// only.
    if (filesystem.backend === "nexus" && filesystem.options !== undefined) {
      const mountUri = (filesystem.options as Record<string, unknown>).mountUri;
      const candidates: unknown[] =
        typeof mountUri === "string"
          ? [mountUri]
          : Array.isArray(mountUri)
            ? (mountUri as unknown[])
            : [];
      // Runtime `resolveFileSystemAsync` rejects multi-mount local-bridge
      // configs because createNexusFileSystem accepts only one mountPoint
      // prefix (#1777 review round 9). Validating the runtime invariant
      // at parse time turns "looks valid, fails later on startup" into a
      // clean error before any subprocess spawn.
      if (candidates.length > 1) {
        return {
          ok: false,
          error:
            "manifest.filesystem.options.mountUri may declare at most one URI on this host. " +
            "Multi-mount local-bridge configs are not yet supported by the runtime resolver.",
        };
      }
      if (!(options?.allowOAuthSchemes === true)) {
        const invalid = candidates.find((u) => typeof u !== "string" || !isSupportedMountUri(u));
        if (invalid !== undefined) {
          return {
            ok: false,
            error:
              `manifest.filesystem.options.mountUri "${String(invalid)}" is not supported on this host. ` +
              `Only \`local://...\` URIs are wired today; OAuth-backed connectors ` +
              `(gdrive://, s3://, etc.) require channel-aware auth handling which is ` +
              `out of scope for the current manifest filesystem wiring.`,
          };
        }
      }
    }
  }

  return {
    ok: true,
    value: {
      modelName: modelName.trim(),
      instructions: instructions as string | undefined,
      stacks,
      plugins,
      backgroundSubprocesses,
      filesystem,
      middleware: middlewareResult.value,
      governance: governanceResult.value,
      supervision: supervisionResult.value,
      audit: auditResult.value,
    },
  };
}

/**
 * Parse the manifest `supervision:` section. Accepts:
 *   strategy: one_for_one | one_for_all | rest_for_one
 *     (accepts the bare string or the explicit { kind: ... } form)
 *   maxRestarts: non-negative integer (default 5)
 *   maxRestartWindowMs: positive number (default 60_000)
 *   children: list of { name, restart, shutdownTimeoutMs?, isolation? }
 *
 * Returns `{ ok: true, value: undefined }` when the section is absent so
 * manifests without supervision stay opt-out.
 */
function parseManifestSupervision(
  raw: unknown,
):
  | { readonly ok: true; readonly value: SupervisionConfig | undefined }
  | { readonly ok: false; readonly error: string } {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error:
        "manifest.supervision must be an object with keys: strategy, maxRestarts, maxRestartWindowMs, children",
    };
  }
  const obj = raw as Record<string, unknown>;

  // Strategy accepts either a bare string (`strategy: one_for_one`) or the
  // discriminated form (`strategy: { kind: one_for_one }`). The canonical
  // shape is the object form; the bare string is a YAML ergonomic shortcut
  // that matches how operators typically write it.
  const strategyRaw = obj.strategy;
  let strategy: SupervisionStrategy;
  if (typeof strategyRaw === "string") {
    if (
      strategyRaw !== "one_for_one" &&
      strategyRaw !== "one_for_all" &&
      strategyRaw !== "rest_for_one"
    ) {
      return {
        ok: false,
        error: `manifest.supervision.strategy must be one of: one_for_one, one_for_all, rest_for_one (got "${strategyRaw}")`,
      };
    }
    strategy = { kind: strategyRaw };
  } else if (typeof strategyRaw === "object" && strategyRaw !== null) {
    const kind = (strategyRaw as Record<string, unknown>).kind;
    if (kind !== "one_for_one" && kind !== "one_for_all" && kind !== "rest_for_one") {
      return {
        ok: false,
        error: `manifest.supervision.strategy.kind must be one of: one_for_one, one_for_all, rest_for_one (got "${String(kind)}")`,
      };
    }
    strategy = { kind };
  } else {
    return {
      ok: false,
      error:
        "manifest.supervision.strategy is required — use e.g. `strategy: one_for_one` or `strategy: { kind: one_for_one }`",
    };
  }

  const maxRestartsRaw = obj.maxRestarts;
  const maxRestarts: number = maxRestartsRaw === undefined ? 5 : Number(maxRestartsRaw);
  const maxRestartWindowMsRaw = obj.maxRestartWindowMs;
  const maxRestartWindowMs: number =
    maxRestartWindowMsRaw === undefined ? 60_000 : Number(maxRestartWindowMsRaw);

  const childrenRaw = obj.children;
  if (!Array.isArray(childrenRaw)) {
    return {
      ok: false,
      error:
        "manifest.supervision.children must be a list of child specs (may be empty). Each entry requires `name` and `restart`.",
    };
  }
  const children: ChildSpec[] = [];
  for (const [i, entry] of childrenRaw.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return {
        ok: false,
        error: `manifest.supervision.children[${i}] must be an object with at least { name, restart }`,
      };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || e.name.length === 0) {
      return {
        ok: false,
        error: `manifest.supervision.children[${i}].name must be a non-empty string`,
      };
    }
    if (e.restart !== "permanent" && e.restart !== "transient" && e.restart !== "temporary") {
      return {
        ok: false,
        error: `manifest.supervision.children[${i}].restart must be one of: permanent, transient, temporary (got "${String(e.restart)}")`,
      };
    }
    const restart: RestartType = e.restart;
    const child: {
      name: string;
      restart: RestartType;
      shutdownTimeoutMs?: number;
      isolation?: ChildIsolation;
    } = { name: e.name, restart };
    if (e.shutdownTimeoutMs !== undefined) {
      const n = Number(e.shutdownTimeoutMs);
      if (!Number.isFinite(n) || n < 0) {
        return {
          ok: false,
          error: `manifest.supervision.children[${i}].shutdownTimeoutMs must be a non-negative number`,
        };
      }
      child.shutdownTimeoutMs = n;
    }
    if (e.isolation !== undefined) {
      if (e.isolation !== "in-process" && e.isolation !== "subprocess") {
        return {
          ok: false,
          error: `manifest.supervision.children[${i}].isolation must be "in-process" or "subprocess"`,
        };
      }
      child.isolation = e.isolation;
    }
    children.push(child);
  }

  const config: SupervisionConfig = {
    strategy,
    maxRestarts,
    maxRestartWindowMs,
    children,
  };
  const valid = validateSupervisionConfig(config);
  if (!valid.ok) {
    return { ok: false, error: `manifest.supervision: ${valid.error.message}` };
  }
  return { ok: true, value: valid.value };
}

const AUDIT_KNOWN_KEYS = new Set(["ndjson", "sqlite", "violations"]);

// Required filename suffixes for each manifest audit field. Mirrors the
// .audit.ndjson suffix already enforced by resolveAuditFilePath in
// middleware-registry.ts. Prevents repo-authored config from pointing at
// arbitrary in-tree files (package.json, bun.lock, source files) and
// accidentally corrupting them when the sink opens for writing.
const AUDIT_FIELD_SUFFIX: Readonly<Record<string, string>> = {
  ndjson: ".audit.ndjson",
  sqlite: ".audit.db",
  violations: ".violations.db",
} as const;

/**
 * Parse the manifest `audit:` section.
 *
 * When `lenient` is true (gate off): block presence is detected and the
 * `present: true` marker is set, but field values and unknown keys are NOT
 * validated. Use this on hosts where the feature gate is not enabled so a
 * malformed stanza cannot deny startup.
 *
 * When `lenient` is false (strict, gate on): unknown keys are rejected,
 * field values are validated, and paths are anchored to the manifest dir.
 *
 * Returns `{ ok: true, value: undefined }` only when the block is absent.
 * Returns a non-undefined `ManifestAuditConfig` (with `present: true`) when
 * the block is present — even for `audit: {}` — so hosts can always detect
 * block presence for rejection/warning.
 */
function parseManifestAudit(
  raw: unknown,
  manifestPath: string,
  lenient: boolean,
): ParseResult<ManifestAuditConfig | undefined> {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }

  // Lenient mode: detect key presence without validating values so the
  // gate-off fail-closed check in tui-command.ts can refuse startup whenever
  // the manifest author clearly attempted to configure a sink — even when the
  // value is the wrong type (ndjson: 42), an empty string, or a typo'd key.
  // Rules:
  //   • Known key exists (any value) → set field to the string value if it is a
  //     non-empty string, otherwise "" (sentinel: key attempted, value unusable)
  //   • Unknown/typo'd key exists → mark ALL three known fields "" so the
  //     gate-off check fires regardless of which env-var override path applies
  // These strings are NOT validated — callers must not use them as trusted paths.
  if (lenient) {
    // Non-object audit blocks (audit: "string", audit: 42, audit: []) signal
    // authorial intent without a usable shape — mark malformed so tui-command
    // can emit a clear "fix the manifest" error rather than a per-sink override
    // requirement for sinks that were never individually specified.
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {
        ok: true,
        value: {
          present: true,
          malformed: true,
          ndjson: undefined,
          sqlite: undefined,
          violations: undefined,
        },
      };
    }
    const rec = raw as Record<string, unknown>;
    const knownKeys = new Set(["ndjson", "sqlite", "violations"]);
    const hasUnknownKey = Object.keys(rec).some((k) => !knownKeys.has(k));
    // Unknown/typo'd keys → malformed marker, no sentinel fabrication for
    // unrelated known sinks. Known-key sentinels ("") still signal key presence
    // even when the value is a wrong type or empty string.
    if (hasUnknownKey) {
      const lNdjson =
        "ndjson" in rec
          ? typeof rec.ndjson === "string" && rec.ndjson.length > 0
            ? rec.ndjson
            : ""
          : undefined;
      const lSqlite =
        "sqlite" in rec
          ? typeof rec.sqlite === "string" && rec.sqlite.length > 0
            ? rec.sqlite
            : ""
          : undefined;
      const lViolations =
        "violations" in rec
          ? typeof rec.violations === "string" && rec.violations.length > 0
            ? rec.violations
            : ""
          : undefined;
      return {
        ok: true,
        value: {
          present: true,
          malformed: true,
          ndjson: lNdjson,
          sqlite: lSqlite,
          violations: lViolations,
        },
      };
    }
    // Object with only known keys: per-key presence sentinels, no malformed flag.
    const lNdjson =
      "ndjson" in rec
        ? typeof rec.ndjson === "string" && rec.ndjson.length > 0
          ? rec.ndjson
          : ""
        : undefined;
    const lSqlite =
      "sqlite" in rec
        ? typeof rec.sqlite === "string" && rec.sqlite.length > 0
          ? rec.sqlite
          : ""
        : undefined;
    const lViolations =
      "violations" in rec
        ? typeof rec.violations === "string" && rec.violations.length > 0
          ? rec.violations
          : ""
        : undefined;
    return {
      ok: true,
      value: { present: true, ndjson: lNdjson, sqlite: lSqlite, violations: lViolations },
    };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error:
        "manifest.audit must be an object, e.g. audit: { ndjson: ./logs/audit.ndjson, sqlite: ./logs/audit.db }",
    };
  }
  const rec = raw as Record<string, unknown>;

  // Reject unknown keys so typos are caught, not silently ignored.
  for (const key of Object.keys(rec)) {
    if (!AUDIT_KNOWN_KEYS.has(key)) {
      return {
        ok: false,
        error:
          `manifest.audit: unknown key "${key}". Recognized keys: ndjson, sqlite, violations. ` +
          "Check for typos — unknown keys are rejected to prevent silent audit misconfiguration.",
      };
    }
  }

  const manifestDir = dirname(resolvePath(manifestPath));

  // Validate a manifest-supplied audit path:
  //   1. Reject absolute paths.
  //   2. Reject lexical `..` traversal out of the manifest directory.
  //   3. If the parent directory exists, resolve it via `realpathSync` and
  //      confirm it is still inside the real manifest directory (blocks
  //      symlink-escape where a repo commits `logs/` as a symlink to an
  //      external location that passes lexical checks).
  //   4. If the file itself already exists, confirm it is not a symlink.
  const anchorPath = (field: string, value: unknown): ParseResult<string | undefined> => {
    if (value === undefined) return { ok: true, value: undefined };
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false,
        error: `manifest.audit.${field} must be a non-empty string path`,
      };
    }
    if (isAbsolute(value)) {
      return {
        ok: false,
        error:
          `manifest.audit.${field}: absolute path "${value}" is not allowed — ` +
          "manifest audit paths must be relative to the manifest directory. " +
          "Use a relative path (e.g. ./logs/audit.ndjson) or the KOI_AUDIT_NDJSON / KOI_AUDIT_SQLITE env vars for absolute paths.",
      };
    }

    // Require a dedicated audit-only suffix to prevent repo-authored config
    // from targeting arbitrary in-tree files (package.json, bun.lock, etc.)
    // and corrupting them when the sink opens for writing.
    const requiredSuffix = AUDIT_FIELD_SUFFIX[field];
    if (requiredSuffix !== undefined && !value.endsWith(requiredSuffix)) {
      return {
        ok: false,
        error:
          `manifest.audit.${field}: "${value}" must end with "${requiredSuffix}". ` +
          "The suffix requirement prevents manifest config from targeting arbitrary in-tree files. " +
          `Example: ./logs/audit${requiredSuffix}`,
      };
    }

    // Lexical `..` check — catches traversal before any filesystem access.
    // Use exact segment matching (rel === ".." or starts with "../") rather
    // than a plain startsWith("..") prefix so directory names like "..logs/"
    // are not incorrectly rejected.
    const lexicalResolved = resolvePath(manifestDir, value);
    const lexicalRel = relative(manifestDir, lexicalResolved);
    if (lexicalRel === ".." || lexicalRel.startsWith(`..${sep}`) || isAbsolute(lexicalRel)) {
      return {
        ok: false,
        error:
          `manifest.audit.${field}: path "${value}" escapes the manifest directory via ".." traversal. ` +
          "Audit paths must stay within the manifest directory when configured from manifest content. " +
          "Use the KOI_AUDIT_NDJSON / KOI_AUDIT_SQLITE env vars to point at paths outside the manifest directory.",
      };
    }

    // Symlink-aware containment: resolve the parent directory to its real path
    // and verify it is still inside the real manifest directory.
    let realManifestDir: string;
    try {
      realManifestDir = realpathSync(manifestDir);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code ?? "unknown";
      return {
        ok: false,
        error:
          `manifest.audit: cannot resolve manifest directory "${manifestDir}" (${code}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const parentDir = dirname(lexicalResolved);
    let realParentDir: string;
    try {
      realParentDir = realpathSync(parentDir);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Require the parent directory to exist at load time. Accepting a
        // missing parent would let sessions start with audit "enabled" while
        // writes fail later — an undetected gap in a compliance feature.
        return {
          ok: false,
          error:
            `manifest.audit.${field}: parent directory "${parentDir}" does not exist. ` +
            "Create the directory before running koi tui with this manifest, or remove the audit path.",
        };
      }
      return {
        ok: false,
        error:
          `manifest.audit.${field}: cannot resolve parent directory "${parentDir}" (${code ?? "unknown"}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const parentRel = relative(realManifestDir, realParentDir);
    if (parentRel === ".." || parentRel.startsWith(`..${sep}`) || isAbsolute(parentRel)) {
      return {
        ok: false,
        error:
          `manifest.audit.${field}: path "${value}" resolves through a symlinked parent directory ` +
          `that escapes the manifest directory (real parent: "${realParentDir}", real manifest dir: "${realManifestDir}"). ` +
          "Audit paths must stay within the manifest directory when configured from manifest content.",
      };
    }

    // If the file itself already exists, verify it is neither a symlink nor a
    // hard link to an inode outside the manifest tree. Hard links (nlink > 1)
    // pass parent-directory containment checks because they live inside the
    // manifest dir, but their inode may be shared with a file outside that
    // tree, redirecting audit writes to an arbitrary host path.
    try {
      const stat = lstatSync(lexicalResolved);
      if (stat.isSymbolicLink()) {
        return {
          ok: false,
          error:
            `manifest.audit.${field}: "${value}" is a symlink — audit files cannot be written via ` +
            "symlinks when configured from manifest content. Replace the symlink with a regular file path.",
        };
      }
      if (stat.nlink > 1) {
        return {
          ok: false,
          error:
            `manifest.audit.${field}: "${value}" is a hard link (nlink=${stat.nlink}) — audit files ` +
            "must have a unique inode when configured from manifest content. Remove the hard link or " +
            "delete the file so koi can create it fresh.",
        };
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        return {
          ok: false,
          error:
            `manifest.audit.${field}: cannot stat "${lexicalResolved}" (${code ?? "unknown"}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // File doesn't exist yet — expected happy path.
    }

    return { ok: true, value: lexicalResolved };
  };

  const ndjsonResult = anchorPath("ndjson", rec.ndjson);
  if (!ndjsonResult.ok) return ndjsonResult;

  const sqliteResult = anchorPath("sqlite", rec.sqlite);
  if (!sqliteResult.ok) return sqliteResult;

  const violationsResult = anchorPath("violations", rec.violations);
  if (!violationsResult.ok) return violationsResult;

  return {
    ok: true,
    value: {
      present: true,
      ndjson: ndjsonResult.value,
      sqlite: sqliteResult.value,
      violations: violationsResult.value,
    },
  };
}

/**
 * Re-validate a manifest-derived audit path immediately before use to close
 * the TOCTOU window between manifest load and sink creation. Uses the same
 * canonical containment check as `anchorPath` (realpathSync on parent + lstat
 * on file), so ancestor symlink swaps that are missed by a plain lstat of only
 * the terminal parent are caught.
 *
 * Returns `undefined` when the path is still safe, or an error string if the
 * path has been compromised (symlinked parent, symlinked file, or the canonical
 * parent is now outside the manifest directory).
 */
export function revalidateAuditPathContainment(
  resolvedPath: string,
  manifestPath: string,
): string | undefined {
  const manifestDir = dirname(resolvePath(manifestPath));

  let realManifestDir: string;
  try {
    realManifestDir = realpathSync(manifestDir);
  } catch {
    return `cannot resolve manifest directory "${manifestDir}"`;
  }

  const parentDir = dirname(resolvedPath);
  let realParentDir: string;
  try {
    realParentDir = realpathSync(parentDir);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return `parent directory "${parentDir}" no longer exists`;
    }
    return `cannot check parent directory "${parentDir}" (${code ?? "unknown"}): ${err instanceof Error ? err.message : String(err)}`;
  }

  const parentRel = relative(realManifestDir, realParentDir);
  if (parentRel === ".." || parentRel.startsWith(`..${sep}`) || isAbsolute(parentRel)) {
    return `"${resolvedPath}" now resolves through a symlinked ancestor that escapes the manifest directory (real parent: "${realParentDir}", real manifest dir: "${realManifestDir}")`;
  }

  try {
    const stat = lstatSync(resolvedPath);
    if (stat.isSymbolicLink()) {
      return `"${resolvedPath}" is now a symlink`;
    }
    if (stat.nlink > 1) {
      return `"${resolvedPath}" is now a hard link (nlink=${stat.nlink}) — inode may be shared with a path outside the manifest tree`;
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return `cannot stat "${resolvedPath}" (${code ?? "unknown"}): ${err instanceof Error ? err.message : String(err)}`;
    }
    // File does not exist yet — expected.
  }

  return undefined;
}

/**
 * Parse the manifest `governance:` section. Accepts any subset of:
 *   maxSpend (non-negative float)
 *   maxTurns (positive int)
 *   maxSpawnDepth (positive int)
 *   policyFile (non-empty string — anchored to manifest dir if relative)
 *   alertThresholds (array of floats in (0, 1])
 *
 * Returns `{ ok: true, value: undefined }` when the section is absent so
 * shared manifests without governance defaults stay unchanged.
 */
function parseManifestGovernance(
  raw: unknown,
  manifestPath: string,
): ParseResult<ManifestGovernanceConfig | undefined> {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error:
        "manifest.governance must be an object, e.g. governance: { maxSpend: 2.50, maxTurns: 50 }",
    };
  }
  const rec = raw as Record<string, unknown>;

  let maxSpend: number | undefined;
  if (rec.maxSpend !== undefined) {
    if (typeof rec.maxSpend !== "number" || !Number.isFinite(rec.maxSpend) || rec.maxSpend < 0) {
      return {
        ok: false,
        error: "manifest.governance.maxSpend must be a non-negative finite number (USD)",
      };
    }
    maxSpend = rec.maxSpend;
  }

  let maxTurns: number | undefined;
  if (rec.maxTurns !== undefined) {
    if (!Number.isInteger(rec.maxTurns) || (rec.maxTurns as number) < 1) {
      return {
        ok: false,
        error: "manifest.governance.maxTurns must be a positive integer",
      };
    }
    maxTurns = rec.maxTurns as number;
  }

  let maxSpawnDepth: number | undefined;
  if (rec.maxSpawnDepth !== undefined) {
    if (!Number.isInteger(rec.maxSpawnDepth) || (rec.maxSpawnDepth as number) < 1) {
      return {
        ok: false,
        error: "manifest.governance.maxSpawnDepth must be a positive integer",
      };
    }
    maxSpawnDepth = rec.maxSpawnDepth as number;
  }

  let policyFile: string | undefined;
  if (rec.policyFile !== undefined) {
    if (typeof rec.policyFile !== "string" || rec.policyFile.length === 0) {
      return {
        ok: false,
        error: "manifest.governance.policyFile must be a non-empty string",
      };
    }
    // Anchor relative paths to the manifest directory so shared manifests
    // keep working when the CLI is invoked from a different cwd — mirrors
    // the filesystem/mountUri anchoring above.
    policyFile = isAbsolute(rec.policyFile)
      ? rec.policyFile
      : resolvePath(dirname(resolvePath(manifestPath)), rec.policyFile);
  }

  let alertThresholds: readonly number[] | undefined;
  if (rec.alertThresholds !== undefined) {
    if (!Array.isArray(rec.alertThresholds) || rec.alertThresholds.length === 0) {
      return {
        ok: false,
        error: "manifest.governance.alertThresholds must be a non-empty array of numbers in (0, 1]",
      };
    }
    for (const t of rec.alertThresholds) {
      if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || t > 1) {
        return {
          ok: false,
          error: `manifest.governance.alertThresholds entries must each be a number in (0, 1], got ${JSON.stringify(t)}`,
        };
      }
    }
    alertThresholds = rec.alertThresholds as readonly number[];
  }

  return {
    ok: true,
    value: { maxSpend, maxTurns, maxSpawnDepth, policyFile, alertThresholds },
  };
}

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * Parse `manifest.middleware` (zone B). Accepts two entry shapes:
 *
 *   # Explicit form
 *   - name: "@koi/middleware-audit"
 *     options: { filePath: "./session.audit.ndjson" }
 *     enabled: true
 *
 *   # Shorthand form — single-key object becomes {name, options}
 *   - "@koi/middleware-audit": { filePath: "./session.audit.ndjson" }
 *
 * Rejects any entry whose name appears in `CORE_MIDDLEWARE_BLOCKLIST` —
 * core layers are configured by host flags, not the manifest.
 *
 * Built-in registrations and the options each accepts are documented
 * in `docs/L2/manifest.md` under "Built-in registrations."
 */
function parseManifestMiddleware(
  raw: unknown,
): ParseResult<readonly ManifestMiddlewareEntry[] | undefined> {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error:
        'manifest.middleware must be a list of entries, e.g. middleware: [{name: "@koi/middleware-audit"}]',
    };
  }

  const out: ManifestMiddlewareEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    const normalized = normalizeMiddlewareEntry(entry, i);
    if (!normalized.ok) {
      return normalized;
    }
    if (CORE_MIDDLEWARE_BLOCKLIST.includes(normalized.value.name)) {
      return {
        ok: false,
        error: `manifest.middleware[${i}]: "${normalized.value.name}" is a core middleware — configure it via host flags, not the manifest.\nblocked names: ${CORE_MIDDLEWARE_BLOCKLIST.join(", ")}`,
      };
    }
    out.push(normalized.value);
  }
  return { ok: true, value: out };
}

function normalizeMiddlewareEntry(
  entry: unknown,
  index: number,
): ParseResult<ManifestMiddlewareEntry> {
  if (typeof entry !== "object" || entry === null) {
    return {
      ok: false,
      error: `manifest.middleware[${index}] must be an object (explicit {name, options} or shorthand {"@koi/name": {options}})`,
    };
  }

  const rec = entry as Record<string, unknown>;

  // Explicit form: has `name` field.
  if (typeof rec.name === "string") {
    if (rec.name.length === 0) {
      return {
        ok: false,
        error: `manifest.middleware[${index}].name must be a non-empty string`,
      };
    }
    const options = rec.options;
    if (
      options !== undefined &&
      (typeof options !== "object" || options === null || Array.isArray(options))
    ) {
      return {
        ok: false,
        error: `manifest.middleware[${index}].options must be an object (or omitted)`,
      };
    }
    const enabledRaw = rec.enabled;
    if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
      return {
        ok: false,
        error: `manifest.middleware[${index}].enabled must be a boolean (or omitted)`,
      };
    }
    return {
      ok: true,
      value: {
        name: rec.name,
        options: options as Readonly<Record<string, unknown>> | undefined,
        enabled: enabledRaw === undefined ? true : enabledRaw,
      },
    };
  }

  // Shorthand form: single-key object whose value is the options record.
  const keys = Object.keys(rec);
  if (keys.length !== 1) {
    return {
      ok: false,
      error: `manifest.middleware[${index}] shorthand form requires exactly one key (got ${keys.length}): use {"@koi/name": {options}} or the explicit {name, options} form`,
    };
  }
  const name = keys[0];
  if (name === undefined || name.length === 0) {
    return {
      ok: false,
      error: `manifest.middleware[${index}] shorthand key must be a non-empty string`,
    };
  }
  const optionsRaw = rec[name];
  if (
    optionsRaw !== undefined &&
    (typeof optionsRaw !== "object" || optionsRaw === null || Array.isArray(optionsRaw))
  ) {
    return {
      ok: false,
      error: `manifest.middleware[${index}] shorthand value must be an options object (or null/omitted)`,
    };
  }
  return {
    ok: true,
    value: {
      name,
      options: optionsRaw as Readonly<Record<string, unknown>> | undefined,
      enabled: true,
    },
  };
}
