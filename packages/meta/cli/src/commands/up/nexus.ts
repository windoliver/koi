/**
 * Nexus lifecycle phases — startup and shutdown via Docker Compose.
 */

import type { NexusMode } from "@koi/runtime-presets";

export interface NexusStartOptions {
  /** Build images from source instead of pulling pre-built. Requires `sourceDir`. */
  readonly build?: boolean | undefined;
  /** Path to the nexus repo root (derives docker-compose.yml for --build). */
  readonly sourceDir?: string | undefined;
  /** Override the Nexus HTTP port. */
  readonly port?: number | undefined;
}

export interface NexusStartResult {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
}

/**
 * Starts the Nexus stack via `nexus up` (Docker Compose lifecycle).
 * Auto-runs `nexus init` if `nexus.yaml` is missing in the workspace.
 */
export async function startNexusStack(
  workspaceRoot: string,
  koiPreset: string,
  verbose: boolean,
  nexusOptions?: NexusStartOptions | undefined,
): Promise<NexusStartResult | undefined> {
  try {
    const { nexusUp } = await import("@koi/nexus-embed");
    const result = await nexusUp({
      cwd: workspaceRoot,
      koiPreset,
      verbose,
      build: nexusOptions?.build,
      sourceDir: nexusOptions?.sourceDir,
      port: nexusOptions?.port,
    });
    if (!result.ok) {
      process.stderr.write(`warn: nexus up failed: ${result.error.message}\n`);
      return undefined;
    }
    if (verbose && result.value.autoInitialized) {
      process.stderr.write("Nexus: auto-initialized nexus.yaml\n");
    }
    return { baseUrl: result.value.baseUrl, apiKey: result.value.apiKey };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warn: Nexus startup failed: ${message}\n`);
    return undefined;
  }
}

/** Stops the Nexus stack via `nexus down`. Best-effort, logs warnings. */
export async function stopNexusStack(workspaceRoot: string, verbose: boolean): Promise<void> {
  try {
    const { nexusDown } = await import("@koi/nexus-embed");
    const result = await nexusDown({ cwd: workspaceRoot, verbose });
    if (!result.ok) {
      process.stderr.write(`warn: nexus down failed: ${result.error.message}\n`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warn: Nexus shutdown failed: ${message}\n`);
  }
}

/** Maps preset nexusMode to the embed profile for `nexus serve --profile <x>`. */
export function mapNexusModeToProfile(mode: NexusMode): string | undefined {
  switch (mode) {
    case "embed-lite":
      return "lite";
    case "embed-auth":
      return "full";
    case "remote":
      return undefined;
  }
}
