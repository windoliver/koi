import { createNexusAuditSink } from "@koi/audit-sink-nexus";
import { createNexusPermissionBackend } from "@koi/permissions-nexus";
import { createNexusRegistry } from "@koi/registry-nexus";
import { createNexusSchedulerBackends } from "@koi/scheduler-nexus";
import { createNexusSearch } from "@koi/search-nexus";
import type { GlobalBackendFactories, GlobalBackendFlags, NexusGlobalBackends } from "./types.js";

const liveGlobalBackendFactories = {
  registry: createNexusRegistry as unknown as GlobalBackendFactories["registry"],
  permissions: createNexusPermissionBackend as unknown as GlobalBackendFactories["permissions"],
  audit: createNexusAuditSink as unknown as GlobalBackendFactories["audit"],
  search: createNexusSearch as unknown as GlobalBackendFactories["search"],
  scheduler: createNexusSchedulerBackends as unknown as GlobalBackendFactories["scheduler"],
} satisfies GlobalBackendFactories;

export async function createGlobalBackends(
  factories: GlobalBackendFactories,
  flags: GlobalBackendFlags,
): Promise<NexusGlobalBackends> {
  const resolvedFactories = { ...liveGlobalBackendFactories, ...factories };

  return {
    registry: flags.registry === false ? undefined : await resolvedFactories.registry(),
    permissions: flags.permissions === false ? undefined : await resolvedFactories.permissions(),
    audit: flags.audit === false ? undefined : await resolvedFactories.audit(),
    search: flags.search === false ? undefined : await resolvedFactories.search(),
    scheduler: flags.scheduler === false ? undefined : await resolvedFactories.scheduler(),
  };
}
