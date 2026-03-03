/**
 * forge_agent — Creates a new sub-agent with manifest validation.
 * Supports two input modes:
 *   1. `manifestYaml` — raw YAML manifest (existing behavior)
 *   2. `brickIds` — auto-assembles manifest from referenced bricks
 *
 * Requires a ManifestParser injected via ForgeDeps to validate YAML
 * without importing @koi/manifest (avoids L2 peer dependency).
 */

import type { BrickArtifact, Result, Tool } from "@koi/core";
import { brickId } from "@koi/core";
import type { AgentArtifact, ForgeAgentInput, ForgeError, ForgeResult } from "@koi/forge-types";
import { staticError } from "@koi/forge-types";
import { assembleManifest } from "../assemble-manifest.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import {
  buildBaseFields,
  createForgeTool,
  mapParsedBaseFields,
  parseAgentInput,
  runForgePipeline,
} from "./shared.js";

// ---------------------------------------------------------------------------
// onSpawn callback type
// ---------------------------------------------------------------------------

/**
 * Callback invoked after a successful forge_agent artifact creation.
 * The caller (typically L3 or consumer code) uses this to trigger
 * child agent assembly via `spawnChildAgent()`.
 *
 * Returns void — spawn orchestration results are captured by the caller
 * through closure, keeping L2 independent of L1 types.
 */
export type OnForgeAgentSpawn = (artifact: AgentArtifact) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

const FORGE_AGENT_CONFIG: ForgeToolConfig = {
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
      files: { type: "object", description: "Companion files: relative path → content" },
      requires: {
        type: "object",
        description: "Runtime requirements (bins, env, tools)",
        properties: {
          bins: { type: "array", items: { type: "string" } },
          env: { type: "array", items: { type: "string" } },
          tools: { type: "array", items: { type: "string" } },
        },
      },
    },
    required: ["name", "description"],
  },
  handler: forgeAgentHandler,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function forgeAgentHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<ForgeResult, ForgeError>> {
  const parsed = parseAgentInput(input);
  if (!parsed.ok) {
    return parsed;
  }

  // Validate manifest parser is available
  if (deps.manifestParser === undefined) {
    return {
      ok: false,
      error: staticError(
        "MANIFEST_PARSE_FAILED",
        "ManifestParser not provided in ForgeDeps — required for forge_agent",
      ),
    };
  }

  // Resolve manifest YAML from either path
  let manifestYaml: string;
  let _loadedBricks: readonly BrickArtifact[] | undefined;

  if (parsed.value.brickIds !== undefined) {
    // Auto-assembly path
    const assemblyResult = await assembleManifest(parsed.value.brickIds, deps.store, {
      name: parsed.value.name,
      description: parsed.value.description,
      ...(parsed.value.model !== undefined ? { model: parsed.value.model } : {}),
      ...(parsed.value.agentType !== undefined ? { agentType: parsed.value.agentType } : {}),
    });
    if (!assemblyResult.ok) {
      return assemblyResult;
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
      ok: false,
      error: staticError(
        "MANIFEST_PARSE_FAILED",
        `Manifest validation failed: ${parseResult.error}`,
      ),
    };
  }

  const forgeInput: ForgeAgentInput = {
    kind: "agent",
    name: parsed.value.name,
    description: parsed.value.description,
    manifestYaml,
    ...mapParsedBaseFields(parsed.value),
  };

  return runForgePipeline(forgeInput, deps, (report) => ({
    ...buildBaseFields(brickId("placeholder"), forgeInput, report, deps),
    kind: "agent" as const,
    manifestYaml,
    ...(forgeInput.files !== undefined ? { files: forgeInput.files } : {}),
    ...(forgeInput.requires !== undefined ? { requires: forgeInput.requires } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createForgeAgentTool(deps: ForgeDeps, onSpawn?: OnForgeAgentSpawn): Tool {
  if (onSpawn === undefined) {
    return createForgeTool(FORGE_AGENT_CONFIG, deps);
  }

  // Wrap handler to call onSpawn after successful artifact creation
  const wrappedConfig: ForgeToolConfig = {
    ...FORGE_AGENT_CONFIG,
    handler: async (input: unknown, handlerDeps: ForgeDeps) => {
      const result = await forgeAgentHandler(input, handlerDeps);
      if (result.ok) {
        // Load the saved artifact and invoke the spawn callback
        const loadResult = await handlerDeps.store.load(result.value.id);
        if (loadResult.ok && loadResult.value.kind === "agent") {
          // onSpawn failure should not prevent artifact save from succeeding
          try {
            await onSpawn(loadResult.value as AgentArtifact);
          } catch (e: unknown) {
            console.debug("[forge-agent] onSpawn callback failed:", e);
          }
        }
      }
      return result;
    },
  };

  return createForgeTool(wrappedConfig, deps);
}
