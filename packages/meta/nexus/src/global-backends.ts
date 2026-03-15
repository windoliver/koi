/**
 * Eagerly-created global Nexus backends.
 *
 * Registry, permissions, audit, search, scheduler, pay, and nameService
 * are singleton backends shared across all agents. Async backends
 * (registry, nameService) are initialized in parallel via Promise.all().
 */

import { createNexusAuditSink } from "@koi/audit-sink-nexus";
import { createNexusNameService } from "@koi/name-service-nexus";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusPayLedger } from "@koi/pay-nexus";
import { createNexusPermissionBackend } from "@koi/permissions-nexus";
import { createNexusRegistry } from "@koi/registry-nexus";
import { createNexusSchedulerBackends } from "@koi/scheduler-nexus";
import { createNexusSearch } from "@koi/search-nexus";
import type {
  GlobalBackendOverrides,
  NexusGlobalBackends,
  ResolvedNexusConnection,
} from "./types.js";

/**
 * Creates all global (singleton) Nexus backends.
 *
 * - Backends disabled via `overrides.<name> === false` are skipped.
 * - Async backends (registry, nameService) are awaited in parallel.
 * - Override objects are shallow-merged with the base connection config.
 */
export async function createGlobalBackends(
  conn: ResolvedNexusConnection,
  client: NexusClient,
  overrides: GlobalBackendOverrides = {},
): Promise<NexusGlobalBackends> {
  const { baseUrl, apiKey } = conn;
  const fetchFn = conn.fetch;

  // ── Sync backends ──────────────────────────────────────────────────────

  const permissions =
    overrides.permissions === false ? undefined : createNexusPermissionBackend({ client });

  const audit =
    overrides.audit === false
      ? undefined
      : createNexusAuditSink({
          baseUrl,
          apiKey,
          ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
          ...(typeof overrides.audit === "object" ? overrides.audit : {}),
        });

  const search =
    overrides.search === false
      ? undefined
      : createNexusSearch({
          baseUrl,
          apiKey,
          ...(fetchFn !== undefined ? { fetchFn } : {}),
          ...(typeof overrides.search === "object" ? overrides.search : {}),
        });

  const scheduler =
    overrides.scheduler === false
      ? undefined
      : createNexusSchedulerBackends({
          baseUrl,
          apiKey,
          ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
          ...(typeof overrides.scheduler === "object" ? overrides.scheduler : {}),
        });

  const pay =
    overrides.pay === false
      ? undefined
      : createNexusPayLedger({
          baseUrl,
          apiKey,
          ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
          ...(typeof overrides.pay === "object"
            ? {
                ...(overrides.pay.timeoutMs !== undefined
                  ? { timeout: overrides.pay.timeoutMs }
                  : {}),
              }
            : {}),
        });

  // ── Async backends (initialized in parallel) ──────────────────────────

  const registryDisabled = overrides.registry === false;
  const nameServiceDisabled = overrides.nameService === false;

  const registryOverrides = typeof overrides.registry === "object" ? overrides.registry : {};
  const nameServiceOverrides =
    typeof overrides.nameService === "object" ? overrides.nameService : {};

  // Registry is critical — let failures propagate so misconfigurations are visible.
  const registryPromise = registryDisabled
    ? Promise.resolve(undefined)
    : createNexusRegistry({
        baseUrl,
        apiKey,
        ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
        ...registryOverrides,
      });

  // Name service (ANS) is optional — the Nexus server may not have the ANS brick
  // installed yet (returns 404 on /api/ans/name.list). Catch only NOT_FOUND errors
  // so auth/network issues still surface.
  const nameServicePromise = nameServiceDisabled
    ? Promise.resolve(undefined)
    : createNexusNameService({
        baseUrl,
        apiKey,
        ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
        ...nameServiceOverrides,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("404") || message.includes("NOT_FOUND")) {
          return undefined;
        }
        throw err;
      });

  const [registry, nameService] = await Promise.all([registryPromise, nameServicePromise]);

  return {
    registry,
    permissions,
    audit,
    search,
    scheduler,
    pay,
    nameService,
  };
}
