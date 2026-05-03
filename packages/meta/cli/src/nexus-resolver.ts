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
  /** Called on host shutdown when source === "spawned-sandbox"; otherwise no-op. */
  readonly shutdown: () => Promise<void>;
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
    return ok({ url: cliUrl, source: "cli-flag", shutdown: noop });
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
    });
  }

  if (mode === "auto") {
    const url = manifestUrl ?? envUrl;
    if (url !== undefined) {
      return ok({
        url,
        source: manifestUrl !== undefined ? "manifest-url" : "env",
        shutdown: noop,
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
      await deps.stopSandbox(handle);
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
