/**
 * Shared middleware composition — assembles the full middleware + provider
 * arrays from resolved subsystems for createForgeConfiguredKoi.
 *
 * Reused by start.ts, serve.ts, and up.ts.
 */

import type { ComponentProvider, KoiMiddleware, Tool } from "@koi/core";
import { createSingleToolProvider } from "@koi/core";
import type { createForgeBootstrap } from "@koi/forge";
import type { AgentChatBridge } from "./agui-chat-bridge.js";
import type {
  PackageContribution,
  RuntimeContributionGraph,
  StackContribution,
} from "./contribution-graph.js";
import { createContributionBuilder } from "./contribution-graph.js";
import type { AutonomousResult } from "./resolve-autonomous.js";
import type { NexusResolvedState } from "./resolve-nexus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MiddlewareCompositionInput {
  /** Middleware from manifest resolution (resolveAgent). */
  readonly resolved: readonly KoiMiddleware[];
  /** Nexus middleware + providers (from resolveNexusOrWarn). */
  readonly nexus: NexusResolvedState;
  /** Forge bootstrap (from bootstrapForgeOrWarn). */
  readonly forge: ReturnType<typeof createForgeBootstrap> | undefined;
  /** Autonomous agent result (from resolveAutonomousOrWarn). */
  readonly autonomous: AutonomousResult | undefined;
  /** AG-UI chat bridge (for admin chat). */
  readonly chatBridge: AgentChatBridge | undefined;
  /** Additional middleware to prepend (e.g., arena middleware for serve). */
  readonly extra?: readonly KoiMiddleware[];
  /** Additional providers to prepend (e.g., arena providers for serve). */
  readonly extraProviders?: readonly ComponentProvider[];
  /** Data source stack provider (from createDataSourceStack). */
  readonly dataSourceProvider?: ComponentProvider | undefined;
  /** Data source runtime tools (query_datasource, probe_schema). */
  readonly dataSourceTools?: readonly Tool[] | undefined;
  /** Preset-activated middleware (from activatePresetStacks). */
  readonly presetMiddleware?: readonly KoiMiddleware[];
  /** Preset-activated providers (from activatePresetStacks). */
  readonly presetProviders?: readonly ComponentProvider[];
  /** Preset stack contributions (from activatePresetStacks). */
  readonly presetContributions?: readonly StackContribution[];
}

/** Minimal middleware + providers bundle (no contribution tracking). */
export interface SubsystemComposed {
  readonly middleware: readonly KoiMiddleware[];
  readonly providers: readonly ComponentProvider[];
}

export interface ComposedMiddleware extends SubsystemComposed {
  readonly contributions: RuntimeContributionGraph;
}

/** Subsystem middleware/provider collection input. */
export interface SubsystemMiddlewareDeps {
  readonly nexus: NexusResolvedState;
  readonly forge: ReturnType<typeof createForgeBootstrap> | undefined;
  readonly autonomous: AutonomousResult | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collects middleware and providers from resolved subsystems (nexus, forge,
 * autonomous). Used by both `composeRuntimeMiddleware` and the dispatcher
 * to avoid duplicating array construction.
 */
export function collectSubsystemMiddleware(deps: SubsystemMiddlewareDeps): SubsystemComposed {
  const middleware: readonly KoiMiddleware[] = [
    ...deps.nexus.middlewares,
    ...(deps.forge?.middlewares ?? []),
    ...(deps.autonomous?.middleware ?? []),
  ];

  const providers: readonly ComponentProvider[] = [
    ...deps.nexus.providers,
    ...(deps.forge !== undefined ? [deps.forge.provider, deps.forge.forgeToolsProvider] : []),
    ...(deps.autonomous?.providers ?? []),
  ];

  return { middleware, providers };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Composes the full middleware and provider arrays from all resolved subsystems.
 *
 * Order matters: resolved → presetMiddleware → extra → nexus → forge →
 * autonomous → chatBridge.
 */
export function composeRuntimeMiddleware(input: MiddlewareCompositionInput): ComposedMiddleware {
  const subsystem = collectSubsystemMiddleware({
    nexus: input.nexus,
    forge: input.forge,
    autonomous: input.autonomous,
  });

  const middleware: readonly KoiMiddleware[] = [
    ...input.resolved,
    ...(input.presetMiddleware ?? []),
    ...(input.extra ?? []),
    ...subsystem.middleware,
    ...(input.chatBridge !== undefined ? [input.chatBridge.middleware] : []),
  ];

  // Register data source tools as ComponentProviders (one per tool)
  const dsToolProviders: readonly ComponentProvider[] = (input.dataSourceTools ?? []).map((tool) =>
    createSingleToolProvider({
      name: `data-source:${tool.descriptor.name}`,
      toolName: tool.descriptor.name,
      createTool: () => tool,
    }),
  );

  const providers: readonly ComponentProvider[] = [
    ...(input.dataSourceProvider !== undefined ? [input.dataSourceProvider] : []),
    ...dsToolProviders,
    ...(input.presetProviders ?? []),
    ...(input.extraProviders ?? []),
    ...subsystem.providers,
  ];

  // Build contribution graph
  const builder = createContributionBuilder();

  // Manifest-resolved middleware
  if (input.resolved.length > 0) {
    builder.addStack("manifest-middleware", "Manifest Middleware", "manifest", "active", [
      {
        id: "@koi/manifest",
        kind: "middleware",
        source: "manifest",
        middlewareNames: input.resolved.map((m) => m.name),
      },
    ]);
  }

  // Preset stacks + bootstrap contributions (passed from activatePresetStacks + bootstrap functions)
  if (input.presetContributions !== undefined) {
    for (const stack of input.presetContributions) {
      builder.addStack(
        stack.id,
        stack.label,
        stack.source,
        stack.status,
        stack.packages,
        stack.reason,
      );
    }
  }

  // Extra middleware
  if (input.extra !== undefined && input.extra.length > 0) {
    builder.addStack("extra", "Extra Middleware", "runtime", "active", [
      {
        id: "@koi/extra",
        kind: "middleware",
        source: "static",
        middlewareNames: input.extra.map((m) => m.name),
      },
    ]);
  }

  // Chat bridge
  if (input.chatBridge !== undefined) {
    builder.addStack("agui-bridge", "AG-UI Chat Bridge", "runtime", "active", [
      {
        id: "@koi/agui-bridge",
        kind: "middleware",
        source: "static",
        middlewareNames: [input.chatBridge.middleware.name],
      },
    ]);
  }

  // Data sources
  if (
    input.dataSourceProvider !== undefined ||
    (input.dataSourceTools !== undefined && input.dataSourceTools.length > 0)
  ) {
    const dsPkgs: PackageContribution[] = [];
    if (input.dataSourceProvider !== undefined) {
      dsPkgs.push({
        id: "@koi/data-source-stack",
        kind: "provider",
        source: "static",
        providerNames: [input.dataSourceProvider.name],
      });
    }
    if (input.dataSourceTools !== undefined && input.dataSourceTools.length > 0) {
      dsPkgs.push({
        id: "@koi/data-source-stack",
        kind: "tool",
        source: "static",
        toolNames: input.dataSourceTools.map((t) => t.descriptor.name),
      });
    }
    builder.addStack("data-sources", "Data Sources", "runtime", "active", dsPkgs);
  }

  return { middleware, providers, contributions: builder.build() };
}
