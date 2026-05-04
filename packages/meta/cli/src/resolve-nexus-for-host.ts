/**
 * Host-side wiring for `resolveNexusEndpoint` shared by `koi tui` and
 * `koi start` (Issue #1403). Decides whether the host needs a Nexus
 * endpoint, then defers to the pure resolver. The trigger rule:
 *
 *   - explicit `--nexus-url` flag → resolve (for the user's URL)
 *   - explicit `manifest.nexus` block → resolve (operator opted in)
 *   - manifest declares a Nexus consumer (delegation, filesystem,
 *     audit-sink-nexus, permissions-nexus) → resolve so existing wiring
 *     finds NEXUS_URL set
 *   - otherwise → no-op (no spawn, no env mutation)
 *
 * On success, returns `{ url, shutdown? }`. The caller is responsible
 * for setting `process.env.NEXUS_URL` and registering `shutdown()` with
 * the host's teardown sequence.
 */

import type { KoiError, Result } from "@koi/core";
import type { startSandbox, stopSandbox } from "@koi/nexus-sandbox";
import type { ManifestDelegationConfig, ManifestNexusConfig } from "./manifest.js";
import type { NexusEndpoint } from "./nexus-resolver.js";
import { resolveNexusEndpoint } from "./nexus-resolver.js";

export interface ResolveNexusForHostInput {
  readonly manifestNexus: ManifestNexusConfig | undefined;
  readonly manifestDelegation: ManifestDelegationConfig | undefined;
  readonly manifestFilesystem: import("@koi/core").FileSystemConfig | undefined;
  readonly cliNexusUrl: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly deps?:
    | { readonly startSandbox: typeof startSandbox; readonly stopSandbox: typeof stopSandbox }
    | undefined;
}

export async function resolveNexusForHost(
  input: ResolveNexusForHostInput,
): Promise<Result<NexusEndpoint | undefined, KoiError>> {
  if (!hostNeedsNexusEndpoint(input)) {
    return { ok: true, value: undefined };
  }
  const fsExplicitUrl = filesystemExplicitUrl(input.manifestFilesystem);
  const sandboxForced = input.manifestNexus?.mode === "sandbox";
  if (fsExplicitUrl !== undefined && sandboxForced) {
    return {
      ok: false,
      error: {
        code: "INVALID_CONFIG",
        message:
          'manifest.nexus.mode is "sandbox" but manifest.filesystem.options.url is also set — the sandbox spawn would never be reachable through the filesystem backend. Drop the filesystem URL or change nexus.mode to "external"/"auto".',
        retryable: false,
        context: { mode: "sandbox", filesystemUrl: fsExplicitUrl },
      },
    };
  }
  const deps = input.deps ?? (await loadDefaultDeps());
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  // Do NOT fold filesystem.options.url into cliNexusUrl: when delegation or
  // a manifest.nexus block is also present, that fold would silently retarget
  // global Nexus consumers (delegation/audit) at the filesystem tenant. The
  // fs URL stays scoped to the filesystem backend's own resolution; global
  // endpoint follows the cli > manifest.nexus > env precedence.
  const result = await resolveNexusEndpoint(
    {
      manifestNexus: input.manifestNexus,
      cliNexusUrl: input.cliNexusUrl,
      env,
    },
    deps,
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value };
}

function filesystemExplicitUrl(
  fs: import("@koi/core").FileSystemConfig | undefined,
): string | undefined {
  if (fs?.backend !== "nexus" || fs.options === undefined) return undefined;
  const url = (fs.options as Record<string, unknown>).url;
  if (typeof url !== "string") return undefined;
  const trimmed = url.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Decide whether the host needs a global Nexus endpoint resolved (with
 * `process.env.NEXUS_URL` set). Returns true when ANY consumer other than
 * the filesystem backend requires it. The filesystem backend reads its own
 * `options.url`, so a manifest that ONLY declares `filesystem.backend: nexus`
 * with an explicit URL and no `nexus`/`delegation` block needs no global
 * endpoint — fs uses its URL, nothing else needs spawning.
 */
function hostNeedsNexusEndpoint(input: ResolveNexusForHostInput): boolean {
  if (input.cliNexusUrl !== undefined && input.cliNexusUrl.trim() !== "") return true;
  if (input.manifestNexus !== undefined) return true;
  if (input.manifestDelegation?.backend === "nexus") return true;
  if (input.manifestFilesystem?.backend === "nexus") {
    // fs-only trigger: skip resolution when fs already has its own URL.
    return filesystemExplicitUrl(input.manifestFilesystem) === undefined;
  }
  return false;
}

async function loadDefaultDeps(): Promise<{
  readonly startSandbox: typeof startSandbox;
  readonly stopSandbox: typeof stopSandbox;
}> {
  const mod = await import("@koi/nexus-sandbox");
  return { startSandbox: mod.startSandbox, stopSandbox: mod.stopSandbox };
}
