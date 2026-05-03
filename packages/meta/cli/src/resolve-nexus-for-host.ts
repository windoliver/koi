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
  if (!hostNeedsNexus(input)) {
    return { ok: true, value: undefined };
  }
  const deps = input.deps ?? (await loadDefaultDeps());
  const env = input.env ?? (process.env as Record<string, string | undefined>);
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

function hostNeedsNexus(input: ResolveNexusForHostInput): boolean {
  if (input.cliNexusUrl !== undefined && input.cliNexusUrl.trim() !== "") return true;
  if (input.manifestNexus !== undefined) return true;
  if (input.manifestDelegation?.backend === "nexus") return true;
  if (input.manifestFilesystem?.backend === "nexus") return true;
  return false;
}

async function loadDefaultDeps(): Promise<{
  readonly startSandbox: typeof startSandbox;
  readonly stopSandbox: typeof stopSandbox;
}> {
  const mod = await import("@koi/nexus-sandbox");
  return { startSandbox: mod.startSandbox, stopSandbox: mod.stopSandbox };
}
