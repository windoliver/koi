/**
 * Agent instantiation from forge brick artifacts.
 *
 * Parses an AgentArtifact's manifest YAML and returns a KoiRuntime-ready
 * configuration. Lives in L3 since it composes L0 types with L1 factory input.
 */

import type {
  AgentManifest,
  BrickArtifact,
  BrickId,
  ComponentProvider,
  EngineAdapter,
  KoiError,
  KoiMiddleware,
  Result,
} from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for agent instantiation. */
export interface AgentInstantiateConfig {
  /** Factory that creates an EngineAdapter from a parsed manifest. */
  readonly adapterFactory: (manifest: AgentManifest) => EngineAdapter | Promise<EngineAdapter>;
  /** Optional middleware to compose into the instantiated agent. */
  readonly middleware?: readonly KoiMiddleware[] | undefined;
  /** Optional component providers for the instantiated agent. */
  readonly providers?: readonly ComponentProvider[] | undefined;
}

/** Result of agent instantiation — ready to pass to createKoi(). */
export interface AgentInstantiateResult {
  readonly manifest: AgentManifest;
  readonly adapter: EngineAdapter;
  readonly brickId: BrickId;
  readonly middleware: readonly KoiMiddleware[];
  readonly providers: readonly ComponentProvider[];
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isAgentBrick(
  brick: BrickArtifact,
): brick is BrickArtifact & { readonly kind: "agent"; readonly manifestYaml: string } {
  return brick.kind === "agent" && "manifestYaml" in brick;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a runtime-ready configuration from a forge AgentArtifact.
 *
 * Parses the brick's manifestYaml, creates an adapter via the factory,
 * and returns everything needed for createKoi().
 */
export async function createAgentFromBrick(
  brick: BrickArtifact,
  config: AgentInstantiateConfig,
): Promise<Result<AgentInstantiateResult, KoiError>> {
  if (!isAgentBrick(brick)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Brick '${brick.name}' is not an agent brick (kind: '${brick.kind}')`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // Dynamic import to avoid hard L1 dependency at module load time.
  // loadManifestFromString is from @koi/manifest (L0u), safe to import.
  const { loadManifestFromString } = await import("@koi/manifest");
  const parseResult = loadManifestFromString(brick.manifestYaml);
  if (!parseResult.ok) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Failed to parse manifest for brick '${brick.name}': ${parseResult.error.message}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const manifest = parseResult.value.manifest;

  // eslint-disable-next-line no-restricted-syntax -- justified: let for try/catch
  let adapter: EngineAdapter;
  try {
    adapter = await config.adapterFactory(manifest);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Failed to create adapter for brick '${brick.name}': ${message}`,
        retryable: RETRYABLE_DEFAULTS.EXTERNAL,
      },
    };
  }

  return {
    ok: true,
    value: {
      manifest,
      adapter,
      brickId: brick.id as BrickId,
      middleware: config.middleware ?? [],
      providers: config.providers ?? [],
    },
  };
}
