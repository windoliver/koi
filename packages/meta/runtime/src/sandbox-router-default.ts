import type { KoiError, Result, SandboxAdapter } from "@koi/core";
import { createDockerAdapter } from "@koi/sandbox-docker";
import { createOsAdapter } from "@koi/sandbox-os";
import { createSandboxRouter, type SandboxRouter } from "@koi/sandbox-router";

/**
 * Build options for the default sandbox router.
 *
 * `extraAdapters` lets callers supplement the auto-detected adapter chain
 * (e.g., add `@koi/sandbox-ssh` for a specific remote host). The router
 * picks among all of them via capability matching + priority.
 */
export interface CreateDefaultSandboxRouterOptions {
  readonly extraAdapters?: readonly SandboxAdapter[];
  readonly degradedThreshold?: number;
  readonly enableDocker?: boolean;
  readonly dockerImage?: string;
}

/**
 * Build a `SandboxRouter` wired with locally available adapters.
 *
 * - `@koi/sandbox-os` is included whenever the local platform exposes
 *   `bwrap` (Linux) or `sandbox-exec` (macOS). If neither is present, the
 *   OS adapter is omitted.
 * - `@koi/sandbox-docker` is probed when `enableDocker` is true (default).
 *   Probing failures are silently dropped — Docker is best-effort.
 * - Any `extraAdapters` are appended verbatim.
 *
 * Returns `{ ok: false }` only when zero adapters could be assembled (no
 * local OS sandbox, Docker unreachable, no extras). Callers should treat
 * that as a configuration error and surface it to the user.
 */
export async function createDefaultSandboxRouter(
  opts: CreateDefaultSandboxRouterOptions = {},
): Promise<Result<SandboxRouter, KoiError>> {
  const adapters: SandboxAdapter[] = [];

  const osResult = createOsAdapter();
  if (osResult.ok) adapters.push(osResult.value);

  const dockerEnabled = opts.enableDocker ?? true;
  if (dockerEnabled) {
    const dockerResult = await createDockerAdapter(
      opts.dockerImage !== undefined ? { image: opts.dockerImage } : {},
    );
    if (dockerResult.ok) adapters.push(dockerResult.value);
  }

  if (opts.extraAdapters !== undefined) adapters.push(...opts.extraAdapters);

  if (adapters.length === 0) {
    const error: KoiError = {
      code: "UNAVAILABLE",
      message: "No sandbox adapter is available on this host",
      retryable: false,
      context: {
        reason: "no-local-sandbox",
        osError: osResult.ok ? undefined : osResult.error.message,
      },
    };
    return { ok: false, error };
  }

  const config =
    opts.degradedThreshold !== undefined
      ? { adapters, degradedThreshold: opts.degradedThreshold }
      : { adapters };
  return { ok: true, value: createSandboxRouter(config) };
}
