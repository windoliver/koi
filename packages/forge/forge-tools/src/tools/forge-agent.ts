/**
 * forge_agent — Creates a new sub-agent with manifest validation.
 * Supports two input modes:
 *   1. `manifestYaml` — raw YAML manifest (existing behavior)
 *   2. `brickIds` — auto-assembles manifest from referenced bricks
 *
 * Requires a ManifestParser injected via ForgeDeps to validate YAML
 * without importing @koi/manifest (avoids L2 peer dependency).
 */

import type { BrickArtifact, EngineAdapter, Result, Tool } from "@koi/core";
import { brickId } from "@koi/core";
import type {
  AgentArtifact,
  ForgeAgentInput,
  ForgeError,
  ForgeResult,
  VerificationReport,
} from "@koi/forge-types";
import { resolveError, staticError } from "@koi/forge-types";
import { assembleManifest } from "../assemble-manifest.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import {
  buildBaseFields,
  createForgeTool,
  extractPipelineOptions,
  mapParsedBaseFields,
  parseAgentInput,
  runForgePipeline,
} from "./shared.js";

// ---------------------------------------------------------------------------
// onSpawn callback type
// ---------------------------------------------------------------------------

/**
 * Data passed to the onSpawn callback after a successful forge_agent.
 * Extensible — new fields can be added without breaking existing callbacks.
 */
export interface ForgeSpawnData {
  readonly artifact: AgentArtifact;
  /** Resolved engine adapter, if the manifest declared an engine and an engineResolver was provided. */
  readonly engine?: EngineAdapter;
}

/**
 * Callback invoked after a successful forge_agent artifact creation.
 * The caller (typically L3 or consumer code) uses this to trigger
 * child agent assembly via `spawnChildAgent()`.
 *
 * Returns void — spawn orchestration results are captured by the caller
 * through closure, keeping L2 independent of L1 types.
 */
export type OnForgeAgentSpawn = (data: ForgeSpawnData) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

const FORGE_AGENT_DESCRIPTOR = {
  name: "forge_agent",
  description:
    "Creates a new sub-agent from a YAML manifest or brick IDs through the verification pipeline",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      manifestYaml: {
        type: "string",
        description: "Raw YAML manifest (mutually exclusive with brickIds)",
      },
      brickIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Brick IDs to auto-assemble into a manifest (mutually exclusive with manifestYaml)",
      },
      model: { type: "string", description: "Model for auto-assembled manifest" },
      agentType: { type: "string", description: "Agent type for auto-assembled manifest" },
      tags: { type: "array", items: { type: "string" } },
      trigger: {
        type: "array",
        items: { type: "string" },
        description:
          "Activation trigger patterns — short natural language phrases declaring when this agent is relevant",
      },
      files: { type: "object", description: "Companion files: relative path → content" },
      requires: {
        type: "object",
        description: "Runtime requirements (bins, env, tools, agents, npm packages)",
        properties: {
          bins: { type: "array", items: { type: "string" } },
          env: { type: "array", items: { type: "string" } },
          tools: { type: "array", items: { type: "string" } },
          agents: {
            type: "array",
            items: { type: "string" },
            description: "Agent brick names required as peer dependencies",
          },
          packages: {
            type: "object",
            description:
              'npm packages: package name → exact semver version (e.g. { "zod": "3.22.0" })',
          },
          network: {
            type: "boolean",
            description: "Whether this brick requires network access at runtime (default: false)",
          },
        },
      },
      parentBrickId: {
        type: "string",
        description: "Parent brick ID — set when deriving from an existing brick",
      },
      evolutionKind: {
        type: "string",
        description: "Evolution kind: 'fix', 'derived', or 'captured'",
      },
    },
    required: ["name", "description"],
  },
} as const;

// ---------------------------------------------------------------------------
// Internal result — carries resolved engine alongside the forge result
// ---------------------------------------------------------------------------

interface ForgeAgentHandlerResult {
  readonly result: Result<ForgeResult, ForgeError>;
  readonly resolvedEngine?: EngineAdapter | undefined;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function forgeAgentHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<ForgeAgentHandlerResult> {
  const parsed = parseAgentInput(input);
  if (!parsed.ok) {
    return { result: parsed };
  }

  // Validate manifest parser is available
  if (deps.manifestParser === undefined) {
    return {
      result: {
        ok: false,
        error: staticError(
          "MANIFEST_PARSE_FAILED",
          "ManifestParser not provided in ForgeDeps — required for forge_agent",
        ),
      },
    };
  }

  // Resolve manifest YAML from either path
  let manifestYaml: string;
  let _loadedBricks: readonly BrickArtifact[] | undefined;

  if (parsed.value.brickIds !== undefined) {
    // Auto-assembly path
    const assemblyResult = await assembleManifest(
      parsed.value.brickIds,
      deps.store,
      {
        name: parsed.value.name,
        description: parsed.value.description,
        ...(parsed.value.model !== undefined ? { model: parsed.value.model } : {}),
        ...(parsed.value.agentType !== undefined ? { agentType: parsed.value.agentType } : {}),
      },
      { agentId: deps.context.agentId, zoneId: deps.context.zoneId },
    );
    if (!assemblyResult.ok) {
      return { result: assemblyResult };
    }
    manifestYaml = assemblyResult.value.manifestYaml;
    _loadedBricks = assemblyResult.value.loadedBricks;
  } else {
    // Raw YAML path (existing behavior)
    manifestYaml = parsed.value.manifestYaml ?? "";
  }

  // Parse and validate the manifest YAML (both paths)
  const parseResult = await deps.manifestParser.parse(manifestYaml);
  if (!parseResult.ok) {
    return {
      result: {
        ok: false,
        error: staticError(
          "MANIFEST_PARSE_FAILED",
          `Manifest validation failed: ${parseResult.error}`,
        ),
      },
    };
  }

  // Eagerly resolve engine if manifest declared one and a resolver is available
  let resolvedEngine: EngineAdapter | undefined;
  if (deps.engineResolver !== undefined && parseResult.engine !== undefined) {
    const engineResult = await deps.engineResolver(parseResult.engine);
    if (!engineResult.ok) {
      return {
        result: {
          ok: false,
          error: resolveError(
            "ENGINE_RESOLVE_FAILED",
            `Engine resolution failed: ${engineResult.error.message}`,
          ),
        },
      };
    }
    resolvedEngine = engineResult.value;
  }

  const forgeInput: ForgeAgentInput = {
    kind: "agent",
    name: parsed.value.name,
    description: parsed.value.description,
    manifestYaml,
    ...mapParsedBaseFields(parsed.value),
  };

  const result = await runForgePipeline(
    forgeInput,
    deps,
    (report: VerificationReport) => ({
      ...buildBaseFields(brickId("placeholder"), forgeInput, report, deps),
      kind: "agent" as const,
      manifestYaml,
    }),
    extractPipelineOptions(parsed.value),
  );

  return { result, resolvedEngine };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createForgeAgentTool(deps: ForgeDeps, onSpawn?: OnForgeAgentSpawn): Tool {
  const config: ForgeToolConfig = {
    ...FORGE_AGENT_DESCRIPTOR,
    handler: async (input: unknown, handlerDeps: ForgeDeps) => {
      const { result, resolvedEngine } = await forgeAgentHandler(input, handlerDeps);
      if (result.ok && onSpawn !== undefined) {
        // Load the saved artifact and invoke the spawn callback
        const loadResult = await handlerDeps.store.load(result.value.id);
        if (loadResult.ok && loadResult.value.kind === "agent") {
          // onSpawn failure should not prevent artifact save from succeeding
          try {
            await onSpawn({
              artifact: loadResult.value,
              ...(resolvedEngine !== undefined ? { engine: resolvedEngine } : {}),
            });
          } catch (_e: unknown) {
            // Non-fatal: artifact persistence already succeeded.
            // Spawn orchestration failures are reported through the callback closure.
            void _e;
          }
        }
      }
      return result;
    },
  };

  return createForgeTool(config, deps);
}
