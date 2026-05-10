import { createNexusAgentProvider } from "./agent-provider.js";
import { createGlobalBackends } from "./global-backends.js";
import type {
  GlobalBackendFactories,
  GlobalBackendFlags,
  NexusAgentProviderConfig,
  NexusBundle,
  NexusDashboardRow,
  NexusFeatureScope,
  NexusHealthDashboard,
  NexusHealthSnapshot,
  NexusStackConfig,
} from "./types.js";

const GLOBAL_FEATURES = {
  registry: "@koi/registry-nexus",
  permissions: "@koi/permissions-nexus",
  audit: "@koi/audit-sink-nexus",
  search: "@koi/search-nexus",
  scheduler: "@koi/scheduler-nexus",
} as const;

const AGENT_FEATURES = {
  filesystem: "@koi/fs-nexus",
  mailbox: "@koi/ipc-nexus",
  "snapshot-store": "@koi/snapshot-store-nexus",
  "playbook-store": "@koi/playbook-store-nexus",
  "handoff-store": "@koi/handoff",
} as const;

const GROUP_FEATURES = {
  scratchpad: "@koi/scratchpad-nexus",
} as const;

const OPT_IN_FEATURES = {
  workspace: "@koi/workspace-nexus",
} as const;

async function runDisposers(disposers: readonly (() => void | Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(disposers.map(async (dispose) => dispose()));
  const firstFailure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (firstFailure !== undefined) {
    throw firstFailure.reason;
  }
}

type FeatureMap = NexusBundle["features"];

type MutableGlobalBackendFactories = {
  -readonly [K in keyof GlobalBackendFactories]: GlobalBackendFactories[K];
};

function makeFeature(
  key: string,
  scope: NexusFeatureScope,
  sourcePackage: string,
  enabled: boolean,
  available: boolean,
  mode: FeatureMap[string]["mode"],
): FeatureMap[string] {
  return { key, scope, sourcePackage, enabled, available, mode };
}

async function probeTransport(config: NexusStackConfig) {
  if (config.healthCheck !== undefined) {
    return config.healthCheck();
  }
  if (config.transport.health !== undefined) {
    return config.transport.health();
  }
  return undefined;
}

function buildFeatureRows(features: FeatureMap): readonly NexusDashboardRow[] {
  const rows: NexusDashboardRow[] = Object.values(features).map((feature) => {
    const status: NexusDashboardRow["status"] =
      feature.mode === "disabled"
        ? "disabled"
        : feature.mode === "fallback" || feature.mode === "unavailable"
          ? "degraded"
          : "ok";
    return {
      key: feature.key,
      label: feature.key,
      scope: feature.scope,
      sourcePackage: feature.sourcePackage,
      status,
      mode: feature.mode,
    };
  });
  return rows;
}

function buildDashboard(
  transport: NexusHealthSnapshot["transport"],
  features: FeatureMap,
  fallbackActive: boolean,
): NexusHealthDashboard {
  const featureRows = buildFeatureRows(features);
  const transportRow: NexusDashboardRow = {
    key: "transport",
    label: "transport",
    scope: "transport",
    sourcePackage: "@koi/nexus-client",
    status:
      transport === undefined
        ? "disabled"
        : !transport.ok
          ? fallbackActive
            ? "degraded"
            : "unhealthy"
          : transport.value.status === "missing-paths"
            ? "degraded"
            : "ok",
    mode: "probe",
  };
  const rows = [transportRow, ...featureRows];

  if (transport !== undefined && !transport.ok) {
    return {
      status: fallbackActive ? "degraded" : "unhealthy",
      summary: fallbackActive
        ? `Nexus transport unhealthy; local fallback active (${transport.error.message})`
        : `Nexus transport unhealthy: ${transport.error.message}`,
      rows,
    };
  }

  if (fallbackActive) {
    return {
      status: "degraded",
      summary: "Local fallback active for selected Nexus surfaces",
      rows,
    };
  }

  if (transport?.ok && transport.value.status === "missing-paths") {
    return {
      status: "degraded",
      summary: `Nexus reachable but missing probe paths: ${transport.value.notFound.join(", ")}`,
      rows,
    };
  }

  if (Object.values(features).some((feature) => feature.mode === "unavailable")) {
    return {
      status: "degraded",
      summary: "Some enabled Nexus surfaces are unavailable in the active wiring",
      rows,
    };
  }

  return {
    status: "ok",
    summary: "Nexus wiring healthy",
    rows,
  };
}

type AgentProviderShape = NexusStackConfig["agentProvider"];

const AGENT_FACTORY_KEYS = {
  filesystem: "createFileSystem",
  mailbox: "createMailbox",
  "snapshot-store": "createSnapshotStore",
  "playbook-store": "createPlaybookStore",
  "handoff-store": "createHandoffStore",
} as const satisfies Record<keyof typeof AGENT_FEATURES, keyof AgentProviderShape>;

function resolveGlobalFeatures(
  config: NexusStackConfig,
  fallbackActive: boolean,
  features: Record<string, FeatureMap[string]>,
  effectiveFlags: Record<keyof typeof GLOBAL_FEATURES, boolean | undefined>,
  selectedGlobalFactories: MutableGlobalBackendFactories,
): void {
  for (const [key, sourcePackage] of Object.entries(GLOBAL_FEATURES)) {
    const k = key as keyof typeof GLOBAL_FEATURES;
    const enabled = config.global[k] !== false;
    if (!enabled) {
      features[key] = makeFeature(key, "global", sourcePackage, false, false, "disabled");
      continue;
    }
    if (!fallbackActive) {
      features[key] = makeFeature(key, "global", sourcePackage, true, true, "nexus");
      continue;
    }
    const fallbackFactory = config.fallback?.globalFactories?.[k];
    if (fallbackFactory !== undefined) {
      selectedGlobalFactories[k as keyof GlobalBackendFactories] =
        fallbackFactory as GlobalBackendFactories[keyof GlobalBackendFactories];
      features[key] = makeFeature(key, "global", sourcePackage, true, true, "fallback");
    } else {
      effectiveFlags[k] = false;
      features[key] = makeFeature(key, "global", sourcePackage, true, false, "unavailable");
    }
  }
}

function resolveAgentFeatures(
  config: NexusStackConfig,
  selectedAgentProvider: AgentProviderShape,
  fallbackActive: boolean,
  features: Record<string, FeatureMap[string]>,
): void {
  for (const [key, sourcePackage] of Object.entries(AGENT_FEATURES)) {
    const factoryKey = AGENT_FACTORY_KEYS[key as keyof typeof AGENT_FEATURES];
    const hasFactory = selectedAgentProvider[factoryKey] !== undefined;
    features[key] = makeFeature(
      key,
      "agent",
      sourcePackage,
      true,
      hasFactory,
      hasFactory ? (fallbackActive ? "fallback" : "nexus") : "unavailable",
    );
  }
  const hasScratchpad = selectedAgentProvider.createScratchpad !== undefined;
  features.scratchpad = makeFeature(
    "scratchpad",
    "group",
    GROUP_FEATURES.scratchpad,
    config.enableScratchpad,
    config.enableScratchpad && hasScratchpad,
    !config.enableScratchpad
      ? "disabled"
      : hasScratchpad
        ? fallbackActive
          ? "fallback"
          : "nexus"
        : "unavailable",
  );
  const hasWorkspace = selectedAgentProvider.createWorkspace !== undefined;
  features.workspace = makeFeature(
    "workspace",
    "opt-in",
    OPT_IN_FEATURES.workspace,
    config.enableWorkspace,
    config.enableWorkspace && hasWorkspace,
    !config.enableWorkspace
      ? "disabled"
      : hasWorkspace
        ? fallbackActive
          ? "fallback"
          : "nexus"
        : "unavailable",
  );
}

function selectFlags(
  effectiveFlags: Record<keyof typeof GLOBAL_FEATURES, boolean | undefined>,
): GlobalBackendFlags {
  const flags: { -readonly [K in keyof GlobalBackendFlags]: GlobalBackendFlags[K] } = {};
  for (const k of Object.keys(GLOBAL_FEATURES) as (keyof typeof GLOBAL_FEATURES)[]) {
    const v = effectiveFlags[k];
    if (v !== undefined) flags[k] = v;
  }
  return flags;
}

function makeHealthFn(
  config: NexusStackConfig,
  features: Record<string, FeatureMap[string]>,
  fallbackActive: boolean,
): () => Promise<NexusHealthSnapshot> {
  return async () => {
    const transport = await probeTransport(config);
    const dashboard = buildDashboard(transport, features, fallbackActive);
    return { status: dashboard.status, fallbackActive, transport, features, dashboard };
  };
}

export async function createNexusStack(config: NexusStackConfig): Promise<NexusBundle> {
  const initialTransport = await probeTransport(config);
  const fallbackActive =
    config.fallback !== undefined && initialTransport !== undefined && !initialTransport.ok;

  const features: Record<string, FeatureMap[string]> = {};
  const effectiveFlags: Record<keyof typeof GLOBAL_FEATURES, boolean | undefined> = {
    registry: config.global.registry,
    permissions: config.global.permissions,
    audit: config.global.audit,
    search: config.global.search,
    scheduler: config.global.scheduler,
  };
  const selectedGlobalFactories: MutableGlobalBackendFactories = { ...config.globalFactories };
  resolveGlobalFeatures(config, fallbackActive, features, effectiveFlags, selectedGlobalFactories);

  const selectedAgentProvider: AgentProviderShape = fallbackActive
    ? { ...config.agentProvider, ...config.fallback?.agentProvider }
    : config.agentProvider;
  resolveAgentFeatures(config, selectedAgentProvider, fallbackActive, features);

  const provider = createNexusAgentProvider({
    ...selectedAgentProvider,
    enableScratchpad: config.enableScratchpad,
    enableWorkspace: config.enableWorkspace,
  } satisfies NexusAgentProviderConfig);
  const backends = await createGlobalBackends(selectedGlobalFactories, selectFlags(effectiveFlags));
  const disposers: Array<() => void | Promise<void>> = [provider.detach];
  if (config.dispose !== undefined) disposers.push(...config.dispose);
  const health = makeHealthFn(config, features, fallbackActive);

  return {
    backends,
    providers: [provider],
    middlewares: config.middlewares ?? [],
    features,
    config: {
      transportKind: "provided",
      scratchpadEnabled: config.enableScratchpad,
      workspaceEnabled: config.enableWorkspace,
      fallbackActive,
    },
    health,
    dashboard: async () => (await health()).dashboard,
    dispose: async () => runDisposers(disposers),
  };
}
