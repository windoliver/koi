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
import { assembleManifest } from "../assemble-manifest.js";
import type { ForgeError } from "../errors.js";
import { staticError } from "../errors.js";
import type { AgentArtifact, ForgeAgentInput, ForgeResult } from "../types.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import {
  buildBaseFields,
  computeContentHash,
  createForgeTool,
  parseAgentInput,
  runForgePipeline,
} from "./shared.js";

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
    ...(parsed.value.tags !== undefined ? { tags: parsed.value.tags } : {}),
    ...(parsed.value.files !== undefined ? { files: parsed.value.files } : {}),
    ...(parsed.value.requires !== undefined
      ? {
          requires: {
            ...(parsed.value.requires.bins !== undefined
              ? { bins: parsed.value.requires.bins }
              : {}),
            ...(parsed.value.requires.env !== undefined ? { env: parsed.value.requires.env } : {}),
            ...(parsed.value.requires.tools !== undefined
              ? { tools: parsed.value.requires.tools }
              : {}),
          },
        }
      : {}),
  };

  return runForgePipeline(forgeInput, deps, (id, report) => {
    const contentHash = computeContentHash(manifestYaml, forgeInput.files);
    const artifact: AgentArtifact = {
      ...buildBaseFields(id, forgeInput, report, deps, contentHash),
      kind: "agent",
      manifestYaml,
      ...(forgeInput.files !== undefined ? { files: forgeInput.files } : {}),
      ...(forgeInput.requires !== undefined ? { requires: forgeInput.requires } : {}),
    };
    return artifact;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createForgeAgentTool(deps: ForgeDeps): Tool {
  return createForgeTool(FORGE_AGENT_CONFIG, deps);
}
