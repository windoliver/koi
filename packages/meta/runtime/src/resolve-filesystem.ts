/**
 * Filesystem backend dispatch — resolves manifest config to a FileSystemBackend.
 *
 * Follows the existing resolveAdapter()/resolveChannel() pattern in create-runtime.ts.
 * Dispatch logic lives here (L3) instead of L1, keeping the engine vendor-free.
 */

import type { FileSystemBackend, FileSystemConfig, KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { createLocalFileSystem } from "@koi/fs-local";
import type { BridgeNotification } from "@koi/fs-nexus";
import {
  createLocalTransport,
  createNexusFileSystem,
  validateNexusFileSystemConfig,
} from "@koi/fs-nexus";
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
  const backend = config?.backend ?? "local";

  if (backend === "local") {
    return createLocalFileSystem(cwd);
  }

  // backend === "nexus"
  const validated = validateNexusFileSystemConfig(config?.options ?? {});
  if (!validated.ok) {
    throw new Error(`Invalid nexus filesystem config: ${validated.error.message}`);
  }
  return createNexusFileSystem(validated.value);
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
}

function isLocalBridgeOptions(v: unknown): v is LocalBridgeOptions {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).transport === "local" &&
    (v as Record<string, unknown>).mountUri !== undefined
  );
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
 *   const runtime = createRuntime({ filesystem: backend });
 *   // On shutdown: await backend.dispose?.()
 *
 * @param config - Manifest filesystem config.
 * @param cwd - Working directory (used when backend is "local").
 * @param onNotification - Called when auth_required / auth_progress / auth_complete
 *   notifications arrive from the bridge. Wire createAuthNotificationHandler(channel) here.
 */
export async function resolveFileSystemAsync(
  config: FileSystemConfig | undefined,
  cwd: string,
  onNotification?: ((n: BridgeNotification) => void) | undefined,
): Promise<FileSystemBackend> {
  const backend = config?.backend ?? "local";

  // Non-nexus or nexus-http → synchronous resolution (no async needed)
  if (backend === "local") {
    return createLocalFileSystem(cwd);
  }

  const options = config?.options;

  // Local bridge transport — async subprocess setup + auth wiring
  if (isLocalBridgeOptions(options)) {
    const transport = await createLocalTransport({
      mountUri: options.mountUri,
      pythonPath: options.pythonPath,
      startupTimeoutMs: options.startupTimeoutMs,
      callTimeoutMs: options.callTimeoutMs,
      authTimeoutMs: options.authTimeoutMs,
    });

    const unsubscribe =
      onNotification !== undefined ? transport.subscribe(onNotification) : () => {};

    const nexusBackend = createNexusFileSystem({
      url: "local://bridge",
      transport,
    });

    // Wrap dispose to clean up the subscription and transport subprocess
    return {
      ...nexusBackend,
      name: `nexus-local:${Array.isArray(options.mountUri) ? options.mountUri.join(",") : options.mountUri}`,
      dispose: async (): Promise<void> => {
        unsubscribe();
        await nexusBackend.dispose?.();
        transport.close();
      },
    };
  }

  // Nexus HTTP transport — synchronous resolution
  const validated = validateNexusFileSystemConfig(options ?? {});
  if (!validated.ok) {
    throw new Error(`Invalid nexus filesystem config: ${validated.error.message}`);
  }
  return createNexusFileSystem(validated.value);
}
