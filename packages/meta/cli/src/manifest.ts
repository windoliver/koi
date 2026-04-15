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

import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { loadConfig } from "@koi/config";
import type { FileSystemConfig } from "@koi/core";
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
  const mountUri = (options as Record<string, unknown>).mountUri;
  if (mountUri === undefined) return config;
  let nextMountUri: unknown;
  if (typeof mountUri === "string") {
    nextMountUri = absolutizeMountUri(mountUri, manifestDir);
  } else if (Array.isArray(mountUri) && mountUri.every((u) => typeof u === "string")) {
    nextMountUri = (mountUri as string[]).map((u) => absolutizeMountUri(u, manifestDir));
  } else {
    return config;
  }
  return {
    ...config,
    options: { ...(options as Record<string, unknown>), mountUri: nextMountUri },
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
  "goal",
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
  "@koi/middleware-goal",
  "@koi/goal",
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

/**
 * Narrow, auditable opt-outs for security-critical zone-C layers.
 *
 * **Host-controlled only.** This config is NOT accepted from manifest
 * YAML — the manifest loader rejects any top-level `trustedHost:`
 * field with a clear error directing users to host configuration.
 * The rationale: `koi.yaml` is repository content, so letting a
 * committed manifest disable `permissions` or `exfiltration-guard`
 * would let anyone with write access to the repo silently downgrade
 * the security posture of every developer who opens the project.
 *
 * Hosts that genuinely need to relax the baseline (e.g. a sandboxed
 * CI runner with compensating controls) pass a `TrustedHostConfig`
 * programmatically to `createKoiRuntime`, typically threaded from a
 * CLI flag, environment variable, or an out-of-band policy store
 * that cannot be set by repository content. Every enabled opt-out
 * logs a bright startup warning.
 */
export interface TrustedHostConfig {
  readonly disableExfiltrationGuard: boolean;
  readonly disablePermissions: boolean;
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

  // Security baseline opt-outs are NOT accepted from manifest YAML.
  // `koi.yaml` is repository content; letting a committed manifest
  // disable `permissions` or `exfiltration-guard` would let anyone
  // with repo write access silently downgrade the security posture
  // of every developer who opens the project. Hosts that genuinely
  // need to relax the baseline configure it out-of-band (CLI flag,
  // env var, or policy store) directly into `createKoiRuntime`.
  if (raw.trustedHost !== undefined) {
    return {
      ok: false,
      error:
        "manifest.trustedHost is not accepted in koi.yaml — security baseline opt-outs " +
        "(disablePermissions, disableExfiltrationGuard) must be configured by the host " +
        "(CLI flag, env var, or out-of-band policy), not by repository content. " +
        "See docs/L2/manifest.md for the rationale.",
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
    // auth handler that neither host has wired yet — until then the
    // conservative posture is "local bridge only, local:// mounts
    // only". Hosts that add OAuth support can relax this allowlist.
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
    },
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
