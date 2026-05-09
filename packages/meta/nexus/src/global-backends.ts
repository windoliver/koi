import { createNexusAuditSink } from "@koi/audit-sink-nexus";
import { createNexusPermissionBackend } from "@koi/permissions-nexus";
import { createNexusRegistry } from "@koi/registry-nexus";
import { createNexusSchedulerBackends } from "@koi/scheduler-nexus";
import { createNexusSearch } from "@koi/search-nexus";
import type { GlobalBackendFactories, GlobalBackendFlags, NexusGlobalBackends } from "./types.js";

export const liveGlobalBackendImports: Record<string, unknown> = {
  registry: createNexusRegistry,
  permissions: createNexusPermissionBackend,
  audit: createNexusAuditSink,
  search: createNexusSearch,
  scheduler: createNexusSchedulerBackends,
};

export async function createGlobalBackends(
  factories: GlobalBackendFactories,
  flags: GlobalBackendFlags,
): Promise<NexusGlobalBackends> {
  return {
    registry: flags.registry === false ? undefined : await factories.registry(),
    permissions: flags.permissions === false ? undefined : await factories.permissions(),
    audit: flags.audit === false ? undefined : await factories.audit(),
    search: flags.search === false ? undefined : await factories.search(),
    scheduler: flags.scheduler === false ? undefined : await factories.scheduler(),
  };
}
