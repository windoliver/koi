/**
 * forge_agent — Creates a new sub-agent with manifest validation.
 * Requires a ManifestParser injected via ForgeDeps to validate YAML
 * without importing @koi/manifest (avoids L2 peer dependency).
 */

import type { Result, Tool } from "@koi/core";
import type { ForgeError } from "../errors.js";
import { staticError } from "../errors.js";
import type { AgentArtifact, ForgeAgentInput, ForgeResult } from "../types.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import {
  computeContentHash,
  createForgeTool,
  runForgePipeline,
  validateInputFields,
} from "./shared.js";

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

const FORGE_AGENT_CONFIG: ForgeToolConfig = {
  name: "forge_agent",
  description: "Creates a new sub-agent from a YAML manifest through the verification pipeline",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      manifestYaml: { type: "string" },
    },
    required: ["name", "description", "manifestYaml"],
  },
  handler: forgeAgentHandler,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const FORGE_AGENT_FIELDS = [
  { name: "name", type: "string", required: true },
  { name: "description", type: "string", required: true },
  { name: "manifestYaml", type: "string", required: true },
] as const;

async function forgeAgentHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<ForgeResult, ForgeError>> {
  const validationErr = validateInputFields(input, FORGE_AGENT_FIELDS);
  if (validationErr !== undefined) {
    return { ok: false, error: validationErr };
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

  const agentInput = input as ForgeAgentInput;

  // Parse and validate the manifest YAML before entering the pipeline
  const parseResult = await deps.manifestParser.parse(agentInput.manifestYaml);
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
    name: agentInput.name,
    description: agentInput.description,
    manifestYaml: agentInput.manifestYaml,
  };

  return runForgePipeline(forgeInput, deps, (id, report) => {
    const artifact: AgentArtifact = {
      id,
      kind: "agent",
      name: forgeInput.name,
      description: forgeInput.description,
      scope: deps.config.defaultScope,
      trustTier: report.finalTrustTier,
      lifecycle: "active",
      createdBy: deps.context.agentId,
      createdAt: Date.now(),
      version: "0.0.1",
      tags: [],
      usageCount: 0,
      contentHash: computeContentHash(forgeInput.manifestYaml),
      manifestYaml: forgeInput.manifestYaml,
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
