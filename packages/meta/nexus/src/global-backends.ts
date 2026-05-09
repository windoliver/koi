import type {
  GlobalBackendFactories,
  GlobalBackendFlags,
  NexusGlobalBackends,
} from "./types.js";

async function unconfiguredLiveFactory(
  load: () => Promise<unknown>,
  backendName: string,
): Promise<never> {
  await load();
  throw new Error(`${backendName} requires runtime config and must be injected`);
}

const liveGlobalBackendFactories = {
  registry: () =>
    unconfiguredLiveFactory(
      async () => {
        const { createNexusRegistry } = await import("@koi/registry-nexus");
        return createNexusRegistry;
      },
      "registry",
    ),
  permissions: () =>
    unconfiguredLiveFactory(
      async () => {
        const { createNexusPermissionBackend } = await import("@koi/permissions-nexus");
        return createNexusPermissionBackend;
      },
      "permissions",
    ),
  audit: () =>
    unconfiguredLiveFactory(
      async () => {
        const { createNexusAuditSink } = await import("@koi/audit-sink-nexus");
        return createNexusAuditSink;
      },
      "audit",
    ),
  search: () =>
    unconfiguredLiveFactory(
      async () => {
        const { createNexusSearch } = await import("@koi/search-nexus");
        return createNexusSearch;
      },
      "search",
    ),
  scheduler: () =>
    unconfiguredLiveFactory(
      async () => {
        const { createNexusSchedulerBackends } = await import("@koi/scheduler-nexus");
        return createNexusSchedulerBackends;
      },
      "scheduler",
    ),
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
