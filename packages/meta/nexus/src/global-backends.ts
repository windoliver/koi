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
  NexusConnectionConfig,
  NexusGlobalBackends,
} from "./types.js";

/**
 * Creates all global (singleton) Nexus backends.
 *
 * - Backends disabled via `overrides.<name> === false` are skipped.
 * - Async backends (registry, nameService) are awaited in parallel.
 * - Override objects are shallow-merged with the base connection config.
 */
export async function createGlobalBackends(
  conn: NexusConnectionConfig,
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

  const [registry, nameService] = await Promise.all([
    registryDisabled
      ? undefined
      : createNexusRegistry({
          baseUrl,
          apiKey,
          ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
          ...registryOverrides,
        }),
    nameServiceDisabled
      ? undefined
      : createNexusNameService({
          baseUrl,
          apiKey,
          ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
          ...nameServiceOverrides,
        }),
  ]);

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
