/**
 * Shared manifest resolution for CLI commands (start, serve).
 *
 * Creates a registry with all known descriptors, builds a resolution
 * context, and resolves the manifest into runtime instances.
 */

import { dirname, resolve as pathResolve } from "node:path";
import type { KoiError, ModelHandler, Result } from "@koi/core";
import { descriptor as externalEngineDescriptor } from "@koi/engine-external";
import type { LoadedManifest } from "@koi/manifest";
import { descriptor as aceDescriptor } from "@koi/middleware-ace";
import { descriptor as auditDescriptor } from "@koi/middleware-audit";
import { descriptor as callLimitsDescriptor } from "@koi/middleware-call-limits";
import { descriptor as compactorDescriptor } from "@koi/middleware-compactor";
import { descriptor as contextEditingDescriptor } from "@koi/middleware-context-editing";
import { descriptor as guidedRetryDescriptor } from "@koi/middleware-guided-retry";
import { descriptor as payDescriptor } from "@koi/middleware-pay";
import { descriptor as permissionsDescriptor } from "@koi/middleware-permissions";
import { descriptor as piiDescriptor } from "@koi/middleware-pii";
import { descriptor as planningDescriptor } from "@koi/middleware-planning";
import { descriptor as sandboxDescriptor } from "@koi/middleware-sandbox";
import { descriptor as sanitizeDescriptor } from "@koi/middleware-sanitize";
import { descriptor as semanticRetryDescriptor } from "@koi/middleware-semantic-retry";
import { descriptor as toolSelectorDescriptor } from "@koi/middleware-tool-selector";
import { descriptor as turnAckDescriptor } from "@koi/middleware-turn-ack";
import type { ProviderAdapter, ProviderAdapterConfig } from "@koi/model-router";
import {
  createAnthropicAdapter,
  createOpenAIAdapter,
  createOpenRouterAdapter,
} from "@koi/model-router";
import type {
  BrickDescriptor,
  ResolutionContext,
  ResolveApprovalHandler,
  ResolvedManifest,
} from "@koi/resolve";
import { createRegistry, discoverDescriptors, resolveManifest } from "@koi/resolve";
import { descriptor as soulDescriptor } from "@koi/soul";

// ---------------------------------------------------------------------------
// Model provider descriptors — kept in CLI for Phase 1
// ---------------------------------------------------------------------------

const PROVIDER_ENV_KEYS: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;

const PROVIDER_FACTORIES: Readonly<
  Record<string, (config: ProviderAdapterConfig) => ProviderAdapter>
> = {
  anthropic: createAnthropicAdapter,
  openai: createOpenAIAdapter,
  openrouter: createOpenRouterAdapter,
} as const;

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
  // Middleware descriptors (alphabetical)
  aceDescriptor,
  auditDescriptor,
  callLimitsDescriptor,
  compactorDescriptor,
  contextEditingDescriptor,
  guidedRetryDescriptor,
  payDescriptor,
  permissionsDescriptor,
  piiDescriptor,
  planningDescriptor,
  sandboxDescriptor,
  sanitizeDescriptor,
  semanticRetryDescriptor,
  soulDescriptor,
  toolSelectorDescriptor,
  turnAckDescriptor,
  // Model provider descriptors
  ...modelProviderDescriptors,
  // Engine descriptors
  externalEngineDescriptor,
];

// ---------------------------------------------------------------------------
// Dynamic descriptor discovery
// ---------------------------------------------------------------------------

/**
 * Detects the monorepo `packages/` directory relative to this module.
 * Both `src/` and `dist/` live two levels under `packages/cli/`.
 */
function detectPackagesDir(): string {
  return pathResolve(import.meta.dir, "..", "..");
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
  // Discover additional descriptors from packages directory
  const packagesDir = options.packagesDir ?? detectPackagesDir();
  const discoveryResult = await discoverDescriptors(packagesDir);

  // Merge: static descriptors take precedence over discovered ones
  const staticKeys = new Set(ALL_DESCRIPTORS.map(descriptorKey));
  const discovered = discoveryResult.ok
    ? discoveryResult.value.filter((d) => !staticKeys.has(descriptorKey(d)))
    : [];

  if (!discoveryResult.ok) {
    process.stderr.write(`warn: descriptor discovery failed: ${discoveryResult.error.message}\n`);
  }

  const allDescriptors: readonly BrickDescriptor<unknown>[] = [...ALL_DESCRIPTORS, ...discovered];

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
