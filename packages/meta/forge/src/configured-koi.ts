/**
 * createForgeConfiguredKoi — extends createConfiguredKoi with forge activation.
 *
 * When `manifest.forge.enabled` is true:
 * 1. Instantiates the full forge system (runtime, provider, middleware stack)
 * 2. Exposes default forge tools (search_forge, forge_skill, forge_tool, forge_edit, promote_forge)
 * 3. Attaches the forge companion skill
 * 4. Passes runtime, provider, and middlewares into createKoi()
 *
 * When forge is not enabled, delegates directly to createConfiguredKoi().
 *
 * Lives in L3 @koi/forge because it composes L3 @koi/starter with forge L2 packages.
 */

import type {
  ComponentProvider,
  ForgeScope,
  ForgeStore,
  KoiError,
  KoiMiddleware,
  MiddlewareConfig,
  Result,
  SandboxExecutor,
  SigningBackend,
  SnapshotStore,
  ToolPolicy,
  TurnTrace,
} from "@koi/core";
import type { ForgeDashboardEvent, MonitorDashboardEvent } from "@koi/dashboard-types";
import type { KoiRuntime } from "@koi/engine";
import type { ForgeComponentProviderInstance } from "@koi/forge-tools";
import type { ForgeConfig } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import type { LoadedManifest } from "@koi/manifest";
import { createAceToolsProvider, getAceStores } from "@koi/middleware-ace";
import type { ConfiguredKoiOptions, RuntimeOpts } from "@koi/starter";
import { createConfiguredKoi, createMiddlewareRegistry } from "@koi/starter";
import { createForgeToolsProvider } from "./create-forge-tools-provider.js";
import type { FullForgeSystem } from "./create-full-forge-system.js";
import { createFullForgeSystem } from "./create-full-forge-system.js";
import { createMonitorEventBridge } from "./forge-event-bridge.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Raw forge section from the loaded manifest. */
interface ManifestForgeSection {
  readonly enabled?: boolean | undefined;
  readonly maxForgeDepth?: number | undefined;
  readonly maxForgesPerSession?: number | undefined;
  readonly defaultScope?: "agent" | "zone" | "global" | undefined;
  readonly defaultPolicy?: ToolPolicy | undefined;
  readonly scopePromotion?: { readonly requireHumanApproval?: boolean | undefined } | undefined;
}

/** Additional options for forge-aware bootstrap. */
export interface ForgeConfiguredKoiOptions extends ConfiguredKoiOptions {
  /** ForgeStore backend for brick persistence. Required when forge is enabled. */
  readonly forgeStore?: ForgeStore | undefined;
  /** SandboxExecutor for forge verification. Required when forge is enabled. */
  readonly forgeExecutor?: SandboxExecutor | undefined;
  /** Optional signing backend for attestation. */
  readonly forgeSigner?: SigningBackend | undefined;
  /** Override forge config (merged with manifest.forge defaults). */
  readonly forgeConfig?: Partial<ForgeConfig> | undefined;
  /** Resolve the current engine session ID. Enables per-session forge counter reset. */
  readonly resolveSessionId?: (() => string) | undefined;
  /** Trace reader for crystallize middleware. */
  readonly readTraces?: (() => Promise<Result<readonly TurnTrace[], KoiError>>) | undefined;
  /** Optional SnapshotStore for quarantine/demotion event recording. */
  readonly forgeSnapshotStore?: SnapshotStore | undefined;
  /**
   * Optional SSE event sink for self-improvement observability.
   * When provided, forge + monitor events are bridged to dashboard SSE events.
   */
  readonly onDashboardEvent?: ((events: readonly ForgeDashboardEvent[]) => void) | undefined;
  /** Optional sink for individual monitor events (anomaly detection). */
  readonly onMonitorEvent?: ((event: MonitorDashboardEvent) => void) | undefined;
}

/** Return type for createForgeConfiguredKoi — runtime + optional forge system handle. */
export interface ForgeConfiguredKoiResult {
  readonly runtime: KoiRuntime;
  readonly forgeSystem: FullForgeSystem | undefined;
  /** Tear down forge system internals. Call after runtime.dispose(). */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract forge section from a manifest (LoadedManifest has forge?: unknown). */
function extractForgeConfig(
  manifest: ConfiguredKoiOptions["manifest"],
): ManifestForgeSection | undefined {
  if (!("forge" in manifest)) return undefined;
  const raw = (manifest as LoadedManifest).forge;
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  return raw as ManifestForgeSection;
}

// Default no-op trace reader
const EMPTY_TRACES: Result<readonly TurnTrace[], KoiError> = { ok: true, value: [] };
const defaultReadTraces = async (): Promise<Result<readonly TurnTrace[], KoiError>> => EMPTY_TRACES;

/**
 * Empty middleware registry — prevents `createConfiguredKoi` from re-resolving
 * manifest middleware when the caller already provides pre-resolved middleware
 * via `options.middleware`. Without this, middleware declared in manifest.middleware[]
 * gets instantiated twice: once by the caller (e.g. CLI's resolveAgent), and once
 * by starter's resolveManifestMiddleware.
 */
const EMPTY_MIDDLEWARE_REGISTRY = createMiddlewareRegistry(new Map());

// ---------------------------------------------------------------------------
// Manifest-driven ACE pre-resolution
// ---------------------------------------------------------------------------

/** Names under which ACE may appear in manifest.middleware[]. */
const ACE_MIDDLEWARE_NAMES = new Set(["ace", "@koi/middleware-ace"]);

/**
 * Pre-resolution result: the ACE middleware instance plus a manifest copy with
 * ACE stripped from `middleware[]` so `resolveManifestMiddleware` won't try to
 * instantiate it a second time (and won't emit a spurious "not found" warning).
 */
interface AcePreResolution {
  readonly aceMiddleware: KoiMiddleware;
  readonly strippedManifest: ConfiguredKoiOptions["manifest"];
}

/**
 * When the caller relies on manifest-driven middleware resolution (no pre-resolved
 * `options.middleware` with ACE), attempt to resolve ACE from the manifest +
 * registry so that `resolveAceToolsProvider` can wire the tools/skill provider.
 *
 * Avoids double-instantiation by returning a manifest copy with ACE removed from
 * `middleware[]`, so `resolveManifestMiddleware` only sees the remaining entries.
 * Passes the same `RuntimeOpts` (agentDepth) that starter would compute, so the
 * factory contract is honoured.
 */
async function preResolveAceFromManifest(
  options: ForgeConfiguredKoiOptions,
): Promise<AcePreResolution | undefined> {
  // ACE already in pre-resolved middleware — nothing to do
  if (options.middleware?.some((mw) => mw.name === "ace")) return undefined;

  // No custom registry — can't resolve from manifest
  if (options.middlewareRegistry === undefined) return undefined;

  // Check manifest for ACE declaration
  if (!("middleware" in options.manifest)) return undefined;
  const configs = (options.manifest as { middleware?: readonly MiddlewareConfig[] }).middleware;
  if (configs === undefined || configs.length === 0) return undefined;

  const aceConfig = configs.find((m) => ACE_MIDDLEWARE_NAMES.has(m.name));
  if (aceConfig === undefined) return undefined;

  const factory = options.middlewareRegistry.get(aceConfig.name);
  if (factory === undefined) return undefined;

  // Compute RuntimeOpts the same way createConfiguredKoi does (configured-koi.ts:61).
  const agentDepth = options.parentPid !== undefined ? options.parentPid.depth + 1 : 0;
  const runtimeOpts: RuntimeOpts = { agentDepth };

  const aceMiddleware = await factory(aceConfig, runtimeOpts);

  // Strip ACE from manifest.middleware[] so resolveManifestMiddleware won't
  // re-instantiate it or log a spurious "not found" warning.
  const remainingMiddleware = configs.filter((m) => !ACE_MIDDLEWARE_NAMES.has(m.name));
  const strippedManifest = {
    ...options.manifest,
    middleware: remainingMiddleware,
  } as ConfiguredKoiOptions["manifest"];

  return { aceMiddleware, strippedManifest };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Koi runtime with optional forge activation.
 *
 * When `manifest.forge.enabled` is true AND forgeStore + forgeExecutor are provided:
 * - Instantiates createFullForgeSystem()
 * - Creates 5 default forge tools (search, skill, tool, edit, promote)
 * - Attaches forge companion skill
 * - Passes forge runtime, provider, and middlewares into createKoi()
 *
 * When forge is not enabled, delegates directly to createConfiguredKoi().
 */
export async function createForgeConfiguredKoi(
  options: ForgeConfiguredKoiOptions,
): Promise<ForgeConfiguredKoiResult> {
  const forgeSection = extractForgeConfig(options.manifest);

  // When caller provides pre-resolved middleware but no custom registry, inject
  // an empty registry to prevent createConfiguredKoi from double-resolving
  // manifest.middleware[] entries.
  const skipManifestResolve =
    options.middleware !== undefined &&
    options.middleware.length > 0 &&
    options.middlewareRegistry === undefined;

  // Pre-resolve ACE from manifest + registry when not in options.middleware.
  // This covers the manifest-driven path where ACE is declared in the manifest
  // and a custom registry is provided, but options.middleware is empty/absent.
  const acePreResolution = await preResolveAceFromManifest(options);
  const effectiveMiddleware =
    acePreResolution !== undefined
      ? [...(options.middleware ?? []), acePreResolution.aceMiddleware]
      : options.middleware;

  // When ACE was pre-resolved from the manifest, pass a stripped manifest to
  // createConfiguredKoi so resolveManifestMiddleware won't re-instantiate ACE
  // or log a spurious "middleware not found" warning.
  const effectiveManifest =
    acePreResolution !== undefined ? acePreResolution.strippedManifest : options.manifest;

  // Build forge config early so the activation gate respects programmatic overrides.
  // Merge order: defaults ← manifest fields ← options.forgeConfig (overrides win).
  // When no forge section exists in the manifest, default to disabled unless
  // the caller explicitly enables via options.forgeConfig.enabled.
  const forgeConfig = createDefaultForgeConfig({
    enabled: forgeSection?.enabled ?? false,
    ...(forgeSection?.maxForgeDepth !== undefined
      ? { maxForgeDepth: forgeSection.maxForgeDepth }
      : {}),
    ...(forgeSection?.maxForgesPerSession !== undefined
      ? { maxForgesPerSession: forgeSection.maxForgesPerSession }
      : {}),
    ...(forgeSection?.defaultScope !== undefined
      ? { defaultScope: forgeSection.defaultScope }
      : {}),
    ...(forgeSection?.defaultPolicy !== undefined
      ? { defaultPolicy: forgeSection.defaultPolicy }
      : {}),
    ...(forgeSection?.scopePromotion?.requireHumanApproval !== undefined
      ? {
          scopePromotion: {
            requireHumanApproval: forgeSection.scopePromotion.requireHumanApproval,
          },
        }
      : {}),
    // Programmatic overrides win over manifest values
    ...options.forgeConfig,
  });

  // Fast path: forge not enabled (merged config is the single source of truth)
  if (
    !forgeConfig.enabled ||
    options.forgeStore === undefined ||
    options.forgeExecutor === undefined
  ) {
    // Still wire ACE tools provider when ACE middleware is present.
    // Forge tools are NOT available on this path → skip companion skill.
    const aceProvider = resolveAceToolsProvider(effectiveMiddleware, false);
    const providers =
      aceProvider !== undefined ? [...(options.providers ?? []), aceProvider] : options.providers;
    const runtime = await createConfiguredKoi({
      ...options,
      manifest: effectiveManifest,
      ...(effectiveMiddleware !== options.middleware ? { middleware: effectiveMiddleware } : {}),
      ...(providers !== options.providers ? { providers } : {}),
      ...(skipManifestResolve ? { middlewareRegistry: EMPTY_MIDDLEWARE_REGISTRY } : {}),
    });
    return { runtime, forgeSystem: undefined, dispose: () => {} };
  }

  // Derive scope from the merged config (respects both manifest and programmatic override)
  const scope: ForgeScope = forgeConfig.defaultScope;

  // Instantiate forge system
  const forgeSystem = createFullForgeSystem({
    store: options.forgeStore,
    executor: options.forgeExecutor,
    scope,
    forgeConfig,
    readTraces: options.readTraces ?? defaultReadTraces,
    resolveBrickId: (toolName) => {
      // Delegate to provider's lookupBrickId after first attach
      const instance = forgeSystem.provider as {
        readonly lookupBrickId?: (name: string) => string | undefined;
      };
      return instance.lookupBrickId?.(toolName);
    },
    ...(options.forgeSigner !== undefined ? { signer: options.forgeSigner } : {}),
    snapshotStore: options.forgeSnapshotStore,
    onDashboardEvent: options.onDashboardEvent,
  });

  // Build forge tools provider (5 tools + companion skill, created at attach time)
  const forgeToolsProvider = createForgeToolsProvider({
    store: options.forgeStore,
    executor: options.forgeExecutor,
    forgeConfig,
    notifier: forgeSystem.notifier,
    pipeline: forgeSystem.pipeline,
    ...(options.resolveSessionId !== undefined
      ? { resolveSessionId: options.resolveSessionId }
      : {}),
  });

  // Wire ACE tools provider if ACE middleware is present in the resolved middleware.
  // Uses getAceStores() to retrieve the same PlaybookStore instance the middleware uses,
  // ensuring list_playbooks reads from the same store ACE writes to.
  // Forge tools ARE available on this path → include companion skill.
  const aceToolsProvider = resolveAceToolsProvider(effectiveMiddleware, true);

  // Merge forge middleware and providers with user-supplied ones
  const mergedMiddleware: readonly KoiMiddleware[] = [
    ...forgeSystem.middlewares,
    ...(effectiveMiddleware ?? []),
  ];
  const mergedProviders: readonly ComponentProvider[] = [
    forgeSystem.provider,
    forgeToolsProvider,
    ...(aceToolsProvider !== undefined ? [aceToolsProvider] : []),
    ...(options.providers ?? []),
  ];

  // Wire monitor event bridge into agent-monitor callbacks when dashboard events are enabled.
  // This wraps the existing onAnomaly callback so monitor anomalies also emit MonitorDashboardEvent.
  const monitorCallbacks =
    options.onMonitorEvent !== undefined
      ? (() => {
          const monitorBridge = createMonitorEventBridge({
            onDashboardEvent: options.onMonitorEvent,
          });
          const existingCbs = options.callbacks?.["agent-monitor"] ?? options.callbacks?.monitor;
          return {
            "agent-monitor": {
              ...existingCbs,
              onAnomaly: monitorBridge.wrapOnAnomaly(existingCbs?.onAnomaly),
            },
          };
        })()
      : {};

  const runtime = await createConfiguredKoi({
    ...options,
    manifest: effectiveManifest,
    middleware: mergedMiddleware,
    providers: mergedProviders,
    forge: forgeSystem.runtime,
    ...(skipManifestResolve ? { middlewareRegistry: EMPTY_MIDDLEWARE_REGISTRY } : {}),
    callbacks: { ...options.callbacks, ...monitorCallbacks },
  });

  const providerInstance = forgeSystem.provider as ForgeComponentProviderInstance;

  return {
    runtime,
    forgeSystem,
    dispose: (): void => {
      forgeSystem.runtime.dispose?.();
      providerInstance.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// ACE tools wiring
// ---------------------------------------------------------------------------

/**
 * Scan resolved middleware for an ACE instance and create the tools provider
 * with the same PlaybookStore. Returns undefined if ACE is not present.
 *
 * Detects ACE from:
 * 1. Explicitly passed `options.middleware` (CLI path via resolveAgent)
 * 2. Pre-resolved from manifest + registry (via preResolveAceFromManifest)
 *
 * @param includeCompanionSkill — set to false when forge tools are unavailable
 *   (the self-forge skill references forge_skill/forge_tool which would mislead the agent)
 */
function resolveAceToolsProvider(
  middleware: readonly KoiMiddleware[] | undefined,
  includeCompanionSkill: boolean,
): ComponentProvider | undefined {
  if (middleware === undefined) return undefined;

  const aceMiddleware = middleware.find((mw) => mw.name === "ace");
  if (aceMiddleware === undefined) return undefined;

  const stores = getAceStores(aceMiddleware);
  if (stores === undefined) return undefined;

  return createAceToolsProvider({
    playbookStore: stores.playbookStore,
    ...(stores.structuredPlaybookStore !== undefined
      ? { structuredPlaybookStore: stores.structuredPlaybookStore }
      : {}),
    includeCompanionSkill,
  });
}
