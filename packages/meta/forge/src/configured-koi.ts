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
  Agent,
  ComponentProvider,
  ForgeScope,
  ForgeStore,
  KoiError,
  KoiMiddleware,
  Result,
  SandboxExecutor,
  SigningBackend,
  TurnTrace,
} from "@koi/core";
import { skillToken } from "@koi/core";
import type { KoiRuntime } from "@koi/engine";
import type { ForgeDeps } from "@koi/forge-tools";
import {
  createForgeEditTool,
  createForgeSkillTool,
  createForgeToolTool,
  createPromoteForgeTool,
  createSearchForgeTool,
} from "@koi/forge-tools";
import type { ForgeConfig } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import type { LoadedManifest } from "@koi/manifest";
import type { ConfiguredKoiOptions } from "@koi/starter";
import { createConfiguredKoi } from "@koi/starter";
import type { FullForgeSystem } from "./create-full-forge-system.js";
import { createFullForgeSystem } from "./create-full-forge-system.js";
import { FORGE_COMPANION_SKILL } from "./forge-companion-skill.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Raw forge section from the loaded manifest. */
interface ManifestForgeSection {
  readonly enabled?: boolean | undefined;
  readonly maxForgesPerSession?: number | undefined;
  readonly defaultScope?: "agent" | "zone" | "global" | undefined;
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
  /** Trace reader for crystallize middleware. */
  readonly readTraces?: (() => Promise<Result<readonly TurnTrace[], KoiError>>) | undefined;
}

/** Return type for createForgeConfiguredKoi — runtime + optional forge system handle. */
export interface ForgeConfiguredKoiResult {
  readonly runtime: KoiRuntime;
  readonly forgeSystem: FullForgeSystem | undefined;
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

/**
 * Build a ComponentProvider that lazily creates the 5 default forge tools
 * + companion skill at attach() time (when the agent entity is available).
 */
function createForgeToolsProvider(
  store: ForgeStore,
  executor: SandboxExecutor,
  forgeConfig: ForgeConfig,
  notifier: FullForgeSystem["notifier"],
): ComponentProvider {
  return {
    name: "forge-tools",
    priority: 50,
    attach: async (agent: Agent) => {
      // Build ForgeDeps with runtime context from the agent entity
      const deps: ForgeDeps = {
        store,
        executor,
        verifiers: [],
        config: forgeConfig,
        context: {
          agentId: agent.pid.id,
          depth: agent.pid.depth,
          sessionId: `session:${agent.pid.id}`,
          forgesThisSession: 0,
        },
        notifier,
      };

      const components = new Map<string, unknown>();
      // 5 default forge tools
      components.set("tool:search_forge", createSearchForgeTool(deps));
      components.set("tool:forge_skill", createForgeSkillTool(deps));
      components.set("tool:forge_tool", createForgeToolTool(deps));
      components.set("tool:forge_edit", createForgeEditTool(deps));
      components.set("tool:promote_forge", createPromoteForgeTool(deps));
      // Companion skill
      components.set(skillToken("forge-companion") as string, FORGE_COMPANION_SKILL);
      return components;
    },
  };
}

// Default no-op trace reader
const EMPTY_TRACES: Result<readonly TurnTrace[], KoiError> = { ok: true, value: [] };
const defaultReadTraces = async (): Promise<Result<readonly TurnTrace[], KoiError>> => EMPTY_TRACES;

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
  const forgeEnabled = forgeSection?.enabled === true;

  // Fast path: forge not enabled
  if (!forgeEnabled || options.forgeStore === undefined || options.forgeExecutor === undefined) {
    const runtime = await createConfiguredKoi(options);
    return { runtime, forgeSystem: undefined };
  }

  // Build forge config from manifest + overrides
  const scope: ForgeScope = forgeSection.defaultScope ?? "agent";
  const forgeConfig = createDefaultForgeConfig({
    ...options.forgeConfig,
    enabled: true,
    ...(forgeSection.maxForgesPerSession !== undefined
      ? { maxForgesPerSession: forgeSection.maxForgesPerSession }
      : {}),
    ...(forgeSection.defaultScope !== undefined ? { defaultScope: forgeSection.defaultScope } : {}),
  });

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
  });

  // Build forge tools provider (5 tools + companion skill, created at attach time)
  const forgeToolsProvider = createForgeToolsProvider(
    options.forgeStore,
    options.forgeExecutor,
    forgeConfig,
    forgeSystem.notifier,
  );

  // Merge forge middleware and providers with user-supplied ones
  const mergedMiddleware: readonly KoiMiddleware[] = [
    ...forgeSystem.middlewares,
    ...(options.middleware ?? []),
  ];
  const mergedProviders: readonly ComponentProvider[] = [
    forgeSystem.provider,
    forgeToolsProvider,
    ...(options.providers ?? []),
  ];

  const runtime = await createConfiguredKoi({
    ...options,
    middleware: mergedMiddleware,
    providers: mergedProviders,
    forge: forgeSystem.runtime,
  });

  return { runtime, forgeSystem };
}
