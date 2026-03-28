/**
 * Shared manifest resolution for CLI commands (start, serve).
 *
 * Creates a registry with all known descriptors, builds a resolution
 * context, and resolves the manifest into runtime instances.
 */

import { dirname, resolve as pathResolve } from "node:path";
// Channel descriptors (alphabetical)
// NOTE: discord, voice, whatsapp, signal, mobile are excluded — they require
// native binary deps (ffmpeg, libsignal, baileys, @discordjs/voice) that cannot
// be compiled into the standalone binary. They remain available via dynamic
// discovery in dev mode.
import { descriptor as channelChatSdkDescriptor } from "@koi/channel-chat-sdk";
import { descriptor as channelCliDescriptor } from "@koi/channel-cli";
import { descriptor as channelEmailDescriptor } from "@koi/channel-email";
import { descriptor as channelMatrixDescriptor } from "@koi/channel-matrix";
import { descriptor as channelSlackDescriptor } from "@koi/channel-slack";
import { descriptor as channelTeamsDescriptor } from "@koi/channel-teams";
import { descriptor as channelTelegramDescriptor } from "@koi/channel-telegram";
import type { AgentArtifact, ForgeStore, KoiError, ModelHandler, Result } from "@koi/core";
// Engine descriptors (alphabetical)
import { descriptor as acpEngineDescriptor } from "@koi/engine-acp";
import { descriptor as claudeEngineDescriptor } from "@koi/engine-claude";
import { descriptor as externalEngineDescriptor } from "@koi/engine-external";
import { descriptor as loopEngineDescriptor } from "@koi/engine-loop";
import { descriptor as piEngineDescriptor } from "@koi/engine-pi";
import type { LoadedManifest } from "@koi/manifest";
// Middleware descriptors (alphabetical)
import { descriptor as aceDescriptor } from "@koi/middleware-ace";
import { descriptor as auditDescriptor } from "@koi/middleware-audit";
import { descriptor as callDedupDescriptor } from "@koi/middleware-call-dedup";
import { descriptor as callLimitsDescriptor } from "@koi/middleware-call-limits";
import { descriptor as compactorDescriptor } from "@koi/middleware-compactor";
import { descriptor as contextEditingDescriptor } from "@koi/middleware-context-editing";
import { descriptor as eventRulesDescriptor } from "@koi/middleware-event-rules";
import { descriptor as planningDescriptor } from "@koi/middleware-goal";
import { descriptor as guidedRetryDescriptor } from "@koi/middleware-guided-retry";
import { descriptor as outputVerifierDescriptor } from "@koi/middleware-output-verifier";
import { descriptor as payDescriptor } from "@koi/middleware-pay";
import { descriptor as permissionsDescriptor } from "@koi/middleware-permissions";
import { descriptor as piiDescriptor } from "@koi/middleware-pii";
import { descriptor as reflexDescriptor } from "@koi/middleware-reflex";
import { descriptor as reportDescriptor } from "@koi/middleware-report";
import { descriptor as rlmDescriptor } from "@koi/middleware-rlm";
import { descriptor as sandboxDescriptor } from "@koi/middleware-sandbox";
import { descriptor as sanitizeDescriptor } from "@koi/middleware-sanitize";
import { descriptor as semanticRetryDescriptor } from "@koi/middleware-semantic-retry";
import { descriptor as toolAuditDescriptor } from "@koi/middleware-tool-audit";
import { descriptor as toolSelectorDescriptor } from "@koi/middleware-tool-selector";
import { descriptor as turnAckDescriptor } from "@koi/middleware-turn-ack";
import type { ProviderAdapter, ProviderAdapterConfig } from "@koi/model-router";
import {
  descriptor as modelRouterDescriptor,
  PROVIDER_ENV_KEYS,
  PROVIDER_FACTORIES,
} from "@koi/model-router";
// Import from subpaths to keep discover-static.ts out of the compiled binary's
// module graph. The barrel "@koi/resolve" re-exports discover-static which would
// pull in Bun.file() and dynamic import() code that has no business in a binary.
import { registerBundledAgents } from "@koi/resolve/register-bundled-agents";
import { registerCompanionSkills } from "@koi/resolve/register-companion-skills";
import { createRegistry } from "@koi/resolve/registry";
import { resolveManifest } from "@koi/resolve/resolve-manifest";
import type {
  BrickDescriptor,
  ResolutionContext,
  ResolveApprovalHandler,
  ResolvedManifest,
} from "@koi/resolve/types";
// Search descriptors (alphabetical)
import { descriptor as searchBraveDescriptor } from "@koi/search-brave";
import { descriptor as soulDescriptor } from "@koi/soul";

// ---------------------------------------------------------------------------
// Model provider descriptors — provider maps imported from @koi/model-router
// ---------------------------------------------------------------------------

function createModelDescriptor(
  providerName: string,
  envKey: string,
  adapterFactory: (config: ProviderAdapterConfig) => ProviderAdapter,
): BrickDescriptor<ModelHandler> {
  return {
    kind: "model",
    name: providerName,
    optionsValidator: (input: unknown) => {
      // Model options are flexible — accept any object
      if (input !== null && input !== undefined && typeof input !== "object") {
        return {
          ok: false,
          error: {
            code: "VALIDATION" as const,
            message: "Model options must be an object",
            retryable: false,
          },
        };
      }
      return { ok: true, value: input ?? {} };
    },
    factory(options, context) {
      const apiKey = context.env[envKey];
      if (apiKey === undefined || apiKey === "") {
        throw new Error(
          `Missing API key. Set the ${envKey} environment variable to use provider "${providerName}".`,
        );
      }

      const adapter = adapterFactory({ apiKey });
      const model = typeof options.model === "string" ? options.model : "";

      // Return ModelHandler that injects the model name
      const handler: ModelHandler = async (request) => adapter.complete({ ...request, model });
      return handler;
    },
  };
}

/** All model provider descriptors for Phase 1. */
const modelProviderDescriptors: readonly BrickDescriptor<ModelHandler>[] = Object.entries(
  PROVIDER_FACTORIES,
).map(([name, factory]) => {
  const envKey = PROVIDER_ENV_KEYS[name];
  if (envKey === undefined) {
    throw new Error(`No env key configured for provider "${name}"`);
  }
  return createModelDescriptor(name, envKey, factory);
});

// ---------------------------------------------------------------------------
// Registry creation
// ---------------------------------------------------------------------------

/**
 * All descriptors known to the CLI.
 * BrickDescriptor is covariant in T, so KoiMiddleware/ModelHandler widen to unknown.
 */
const ALL_DESCRIPTORS: readonly BrickDescriptor<unknown>[] = [
  // Channel descriptors (alphabetical)
  // discord, voice, whatsapp, signal, mobile excluded — native binary deps
  channelChatSdkDescriptor,
  channelCliDescriptor,
  channelEmailDescriptor,
  channelMatrixDescriptor,
  channelSlackDescriptor,
  channelTeamsDescriptor,
  channelTelegramDescriptor,
  // Middleware descriptors (alphabetical)
  aceDescriptor,
  auditDescriptor,
  callDedupDescriptor,
  callLimitsDescriptor,
  compactorDescriptor,
  contextEditingDescriptor,
  eventRulesDescriptor,
  guidedRetryDescriptor,
  outputVerifierDescriptor,
  payDescriptor,
  permissionsDescriptor,
  piiDescriptor,
  planningDescriptor,
  reflexDescriptor,
  reportDescriptor,
  rlmDescriptor,
  sandboxDescriptor,
  sanitizeDescriptor,
  semanticRetryDescriptor,
  soulDescriptor,
  toolAuditDescriptor,
  toolSelectorDescriptor,
  turnAckDescriptor,
  // Model provider descriptors
  ...modelProviderDescriptors,
  // Model router middleware
  modelRouterDescriptor,
  // Engine descriptors (alphabetical)
  acpEngineDescriptor,
  claudeEngineDescriptor,
  externalEngineDescriptor,
  loopEngineDescriptor,
  piEngineDescriptor,
  // Search descriptors (alphabetical)
  searchBraveDescriptor,
];

// ---------------------------------------------------------------------------
// Dynamic descriptor discovery
// ---------------------------------------------------------------------------

/**
 * Detects the monorepo `packages/` directory relative to this module.
 * This module lives at `packages/meta/cli/src/`, so three levels up
 * reaches the `packages/` root where discoverable packages reside.
 */
function detectPackagesDir(): string {
  return pathResolve(import.meta.dir, "..", "..", "..");
}

/**
 * Builds a unique key for deduplication: `"kind:name"`.
 */
function descriptorKey(d: BrickDescriptor<unknown>): string {
  return `${d.kind}:${d.name}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options for resolving an agent from a manifest. */
export interface ResolveAgentOptions {
  /** Path to the manifest file (koi.yaml). */
  readonly manifestPath: string;
  /** The loaded manifest. */
  readonly manifest: LoadedManifest;
  /** Optional approval handler for HITL permissions. */
  readonly approvalHandler?: ResolveApprovalHandler | undefined;
  /** Override packages directory for discovery (default: auto-detected). */
  readonly packagesDir?: string | undefined;
  /** Optional ForgeStore for companion skill auto-registration. */
  readonly forgeStore?: ForgeStore | undefined;
  /** Optional bundled agents to register into the ForgeStore. */
  readonly bundledAgents?: readonly AgentArtifact[] | undefined;
}

/**
 * Resolves a loaded manifest into runtime instances.
 *
 * Creates a registry, builds context, and runs resolveManifest.
 * Returns either a ResolvedManifest or an error string for stderr.
 */
export async function resolveAgent(
  options: ResolveAgentOptions,
): Promise<Result<ResolvedManifest, KoiError>> {
  // Compiled binaries have all descriptors statically bundled in ALL_DESCRIPTORS.
  // No filesystem access, no dynamic imports, no manifest reads — fully self-contained.
  // Dev mode extends that set by scanning the local packages/ directory.
  const isCompiled = process.argv[0] !== undefined && !process.argv[0].includes("bun");

  let allDescriptors: readonly BrickDescriptor<unknown>[];

  if (isCompiled) {
    // Binary mode: use only statically bundled descriptors — zero filesystem dependency.
    allDescriptors = ALL_DESCRIPTORS;
  } else {
    // Dev mode: discover additional descriptors from packages/ directory.
    // Dynamic import keeps discover-static.ts out of the compiled binary entirely.
    const { discoverDescriptorsAuto } = await import("@koi/resolve/discover-static");
    const packagesDir = options.packagesDir ?? detectPackagesDir();
    const discoveryResult = await discoverDescriptorsAuto(packagesDir);

    const staticKeys = new Set(ALL_DESCRIPTORS.map(descriptorKey));
    const discovered = discoveryResult.ok
      ? discoveryResult.value.filter((d) => !staticKeys.has(descriptorKey(d)))
      : [];

    if (!discoveryResult.ok) {
      process.stderr.write(`warn: descriptor discovery failed: ${discoveryResult.error.message}\n`);
    }

    allDescriptors = [...ALL_DESCRIPTORS, ...discovered];
  }

  // Register companion skills if ForgeStore is provided
  if (options.forgeStore !== undefined) {
    const skillResult = await registerCompanionSkills(allDescriptors, options.forgeStore);
    if (skillResult.ok) {
      const { registered, skipped, errors } = skillResult.value;
      if (registered > 0 || errors.length > 0) {
        process.stderr.write(
          `info: companion skills: ${String(registered)} registered, ${String(skipped)} skipped` +
            (errors.length > 0 ? `, ${String(errors.length)} errors` : "") +
            "\n",
        );
      }
      for (const err of errors) {
        process.stderr.write(`warn: ${err}\n`);
      }
    }

    // Register bundled agents if provided
    if (options.bundledAgents !== undefined && options.bundledAgents.length > 0) {
      const agentResult = await registerBundledAgents(options.bundledAgents, options.forgeStore);
      if (agentResult.ok) {
        const { registered, skipped, errors: agentErrors } = agentResult.value;
        if (registered > 0 || agentErrors.length > 0) {
          process.stderr.write(
            `info: bundled agents: ${String(registered)} registered, ${String(skipped)} skipped` +
              (agentErrors.length > 0 ? `, ${String(agentErrors.length)} errors` : "") +
              "\n",
          );
        }
        for (const err of agentErrors) {
          process.stderr.write(`warn: ${err}\n`);
        }
      }
    }
  }

  // Create registry
  const registryResult = createRegistry(allDescriptors);
  if (!registryResult.ok) {
    return registryResult;
  }

  // Build resolution context
  const context: ResolutionContext = {
    manifestDir: dirname(pathResolve(options.manifestPath)),
    manifest: options.manifest,
    env: process.env,
    approvalHandler: options.approvalHandler,
  };

  // Resolve
  return resolveManifest(options.manifest, registryResult.value, context);
}

/**
 * Formats a resolution error for CLI stderr output.
 */
export { formatResolutionError } from "@koi/resolve";
