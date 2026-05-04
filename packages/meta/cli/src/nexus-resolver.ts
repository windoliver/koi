/**
 * Resolve a Nexus endpoint for `koi start` and `koi tui`.
 *
 * Resolution rules (Issue #1403):
 *   - `mode: "external"` → require URL (CLI flag, manifest.url, or NEXUS_URL env). Fail if missing.
 *   - `mode: "sandbox"`  → always spawn @koi/nexus-sandbox locally.
 *   - `mode: "auto"` (default) → use external URL if set, else spawn sandbox.
 *
 * CLI override (`args.nexusUrl` or `--nexus-url`) wins over everything.
 *
 * The returned `NexusEndpoint` includes a `shutdown()` callback when a
 * subprocess was spawned. Callers must wire it into their teardown so the
 * sandbox process is reaped on exit.
 */

import type { KoiError, Result } from "@koi/core";
import type { ManifestNexusConfig } from "./manifest.js";

export interface NexusEndpoint {
  readonly url: string;
  readonly source: "cli-flag" | "manifest-url" | "env" | "spawned-sandbox";
  /**
   * Called on host shutdown when source === "spawned-sandbox"; otherwise
   * a no-op. Throws when the underlying `stopSandbox` returns `{ ok: false }`
   * so callers can surface drain timeouts / orphan-process failures rather
   * than silently swallowing them.
   */
  readonly shutdown: () => Promise<void>;
  /**
   * Synchronous best-effort SIGTERM. Safe to call from `process.on("exit")`
   * handlers (which forbid async work). For non-spawn sources this is a
   * no-op. Used as the safety net when a host bails before its async
   * `shutdown()` chain has been fully wired.
   */
  readonly terminate: () => void;
}

export interface ResolveNexusEndpointInput {
  readonly manifestNexus: ManifestNexusConfig | undefined;
  readonly cliNexusUrl: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ResolveNexusEndpointDeps {
  readonly startSandbox: typeof import("@koi/nexus-sandbox").startSandbox;
  readonly stopSandbox: typeof import("@koi/nexus-sandbox").stopSandbox;
}

export async function resolveNexusEndpoint(
  input: ResolveNexusEndpointInput,
  deps: ResolveNexusEndpointDeps,
): Promise<Result<NexusEndpoint, KoiError>> {
  const mode = input.manifestNexus?.mode ?? "auto";
  const cliUrl = nonEmpty(input.cliNexusUrl);
  const manifestUrl = nonEmpty(input.manifestNexus?.url);
  const envUrl = nonEmpty(input.env.NEXUS_URL);

  if (cliUrl !== undefined) {
    return ok({ url: cliUrl, source: "cli-flag", shutdown: noop, terminate: noopSync });
  }

  if (mode === "external") {
    const url = manifestUrl ?? envUrl;
    if (url === undefined) {
      return {
        ok: false,
        error: {
          code: "INVALID_CONFIG",
          message:
            'manifest.nexus.mode is "external" but no URL was provided — set manifest.nexus.url, NEXUS_URL env, or pass --nexus-url',
          retryable: false,
          context: { mode: "external" },
        },
      };
    }
    return ok({
      url,
      source: manifestUrl !== undefined ? "manifest-url" : "env",
      shutdown: noop,
      terminate: noopSync,
    });
  }

  if (mode === "auto") {
    const url = manifestUrl ?? envUrl;
    if (url !== undefined) {
      return ok({
        url,
        source: manifestUrl !== undefined ? "manifest-url" : "env",
        shutdown: noop,
        terminate: noopSync,
      });
    }
  }

  // mode === "sandbox" OR mode === "auto" with no URL → spawn.
  const spawnConfig = buildSandboxConfig(input.manifestNexus);
  const spawn = await deps.startSandbox(spawnConfig);
  if (!spawn.ok) return spawn;
  const handle = spawn.value;
  return ok({
    url: handle.baseUrl,
    source: "spawned-sandbox",
    shutdown: async (): Promise<void> => {
      const result = await deps.stopSandbox(handle);
      if (!result.ok) {
        // Surface drain timeout / SIGKILL escalation as an exception so the
        // host's `try { await shutdown(); } catch { … }` block can report it.
        // Without this, stopSandbox's `{ ok: false }` signal is swallowed and
        // pinned ports / orphan processes go unreported to operators.
        throw Object.assign(new Error(`nexus sandbox stop failed: ${result.error.message}`), {
          cause: result.error,
        });
      }
    },
    terminate: (): void => {
      // Sync best-effort: process.on("exit") forbids async, so we only get
      // a few syscalls. The OS reaps the orphan if SIGTERM is ignored — fine
      // for a local-dev daemon. Real graceful drain runs in shutdown().
      try {
        handle._process.kill("SIGTERM");
      } catch {
        /* already dead — nothing to do */
      }
      // Release the port lock too: leaving it behind makes the next start
      // fail with PORT_IN_USE even after the kernel has freed the listener.
      // Lock release is sync (closeSync + unlinkSync), safe in process exit.
      try {
        handle._releasePortLock?.();
      } catch {
        /* lock already released */
      }
    },
  });
}

function buildSandboxConfig(
  cfg: ManifestNexusConfig | undefined,
): import("@koi/nexus-sandbox").SandboxConfig {
  const out: {
    -readonly [K in keyof import("@koi/nexus-sandbox").SandboxConfig]: import("@koi/nexus-sandbox").SandboxConfig[K];
  } = {};
  if (cfg?.port !== undefined) out.port = cfg.port;
  if (cfg?.dataDir !== undefined) out.dataDir = cfg.dataDir;
  if (cfg?.enableVectorSearch !== undefined) out.enableVectorSearch = cfg.enableVectorSearch;
  if (cfg?.embeddingModel !== undefined) out.embeddingModel = cfg.embeddingModel;
  return out;
}

function nonEmpty(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const trimmed = s.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function ok(value: NexusEndpoint): Result<NexusEndpoint, KoiError> {
  return { ok: true, value };
}

const noop: () => Promise<void> = async () => {};
const noopSync: () => void = () => {};
