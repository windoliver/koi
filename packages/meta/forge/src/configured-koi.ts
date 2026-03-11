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
  Result,
  SandboxExecutor,
  SigningBackend,
  SnapshotStore,
  ToolPolicy,
  TurnTrace,
} from "@koi/core";
import type { KoiRuntime } from "@koi/engine";
import type { ForgeComponentProviderInstance } from "@koi/forge-tools";
import type { ForgeConfig } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import type { LoadedManifest } from "@koi/manifest";
import { createAceToolsProvider, getAceStores } from "@koi/middleware-ace";
import type { ConfiguredKoiOptions } from "@koi/starter";
import { createConfiguredKoi, createMiddlewareRegistry } from "@koi/starter";
import { createForgeToolsProvider } from "./create-forge-tools-provider.js";
import type { FullForgeSystem } from "./create-full-forge-system.js";
import { createFullForgeSystem } from "./create-full-forge-system.js";

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
    // Still wire ACE tools provider when ACE middleware is present
    const aceProvider = resolveAceToolsProvider(options.middleware);
    const providers =
      aceProvider !== undefined ? [...(options.providers ?? []), aceProvider] : options.providers;
    const runtime = await createConfiguredKoi({
      ...options,
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
  const aceToolsProvider = resolveAceToolsProvider(options.middleware);

  // Merge forge middleware and providers with user-supplied ones
  const mergedMiddleware: readonly KoiMiddleware[] = [
    ...forgeSystem.middlewares,
    ...(options.middleware ?? []),
  ];
  const mergedProviders: readonly ComponentProvider[] = [
    forgeSystem.provider,
    forgeToolsProvider,
    ...(aceToolsProvider !== undefined ? [aceToolsProvider] : []),
    ...(options.providers ?? []),
  ];

  const runtime = await createConfiguredKoi({
    ...options,
    middleware: mergedMiddleware,
    providers: mergedProviders,
    forge: forgeSystem.runtime,
    ...(skipManifestResolve ? { middlewareRegistry: EMPTY_MIDDLEWARE_REGISTRY } : {}),
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
 */
function resolveAceToolsProvider(
  middleware: readonly KoiMiddleware[] | undefined,
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
  });
}
