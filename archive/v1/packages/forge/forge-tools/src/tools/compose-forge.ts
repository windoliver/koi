/**
 * compose_forge — Composes multiple bricks into a linear pipeline (A→B→C).
 *
 * Loads all referenced bricks from the store, extracts typed I/O ports,
 * validates consecutive schema compatibility, and produces a CompositeArtifact
 * with a content-addressed pipeline ID (order-preserving).
 *
 * v2: Pipeline semantics. Mixed kinds allowed. Order matters.
 */

import type {
  BrickArtifact,
  BrickKind,
  BrickPort,
  CompositeArtifact,
  PipelineStep,
  Result,
  Tool,
} from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY, MAX_PIPELINE_STEPS } from "@koi/core";
import type { ForgeError, ForgePipeline, ForgeResult } from "@koi/forge-types";
import { isVisibleToAgent, staticError, storeError } from "@koi/forge-types";
import { computePipelineBrickId } from "@koi/hash";
import { validatePipeline } from "@koi/validation";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { buildBaseFields, createForgeTool, parseCompositeInput } from "./shared.js";

// Pipeline-aware helper: L2 package uses pipeline (no direct cross-L2 imports)
function getCreateProvenance(deps: ForgeDeps): ForgePipeline["createProvenance"] {
  if (deps.pipeline === undefined) {
    throw new Error("ForgePipeline is required in @koi/forge-tools");
  }
  return deps.pipeline.createProvenance;
}

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

const COMPOSE_FORGE_CONFIG: ForgeToolConfig = {
  name: "compose_forge",
  description:
    "Composes multiple bricks into a linear pipeline (A→B→C). Validates schema compatibility between consecutive steps, produces a CompositeArtifact with content-addressed pipeline identity.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name for the composite brick" },
      description: { type: "string", description: "Description for the composite brick" },
      brickIds: {
        type: "array",
        items: { type: "string" },
        description: "IDs of bricks to compose as an ordered pipeline",
      },
      tags: { type: "array", items: { type: "string" } },
      trigger: {
        type: "array",
        items: { type: "string" },
        description:
          "Activation trigger patterns — short natural language phrases declaring when this composite is relevant",
      },
      files: { type: "object", description: "Additional companion files: relative path → content" },
    },
    required: ["name", "description", "brickIds"],
  },
  handler: composeForgeHandler,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function composeForgeHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<ForgeResult, ForgeError>> {
  const parsed = parseCompositeInput(input);
  if (!parsed.ok) {
    return parsed;
  }

  const { name, description, tags, trigger, files: inputFiles } = parsed.value;

  if (parsed.value.brickIds.length < 2) {
    return {
      ok: false,
      error: staticError("INVALID_SCHEMA", "compose_forge requires at least 2 brickIds"),
    };
  }

  if (parsed.value.brickIds.length > MAX_PIPELINE_STEPS) {
    return {
      ok: false,
      error: staticError(
        "INVALID_SCHEMA",
        `compose_forge pipeline exceeds maximum of ${MAX_PIPELINE_STEPS} steps`,
      ),
    };
  }

  // Load all bricks in parallel
  const loadResults = await Promise.all(
    parsed.value.brickIds.map((id) => deps.store.load(brickId(id))),
  );

  const bricks: BrickArtifact[] = [];
  for (let i = 0; i < loadResults.length; i++) {
    const result = loadResults[i];
    if (result === undefined || !result.ok) {
      return {
        ok: false,
        error: storeError(
          "LOAD_FAILED",
          `Brick not found: ${parsed.value.brickIds[i] ?? "unknown"}`,
        ),
      };
    }
    // justified: mutable local array being constructed, not shared state
    bricks.push(result.value);
  }

  // Visibility check — reject bricks the caller cannot see
  for (const brick of bricks) {
    if (!isVisibleToAgent(brick, deps.context.agentId, deps.context.zoneId)) {
      return {
        ok: false,
        error: storeError("LOAD_FAILED", `Brick not found: ${brick.id}`),
      };
    }
  }

  // Build pipeline steps with extracted ports
  const steps: PipelineStep[] = [];
  for (const brick of bricks) {
    const { inputPort, outputPort } = extractPorts(brick);
    // justified: mutable local array being constructed, not shared state
    steps.push({
      brickId: brick.id,
      inputPort,
      outputPort,
    });
  }

  // Validate pipeline schema compatibility
  const pipelineResult = validatePipeline(steps);
  if (!pipelineResult.valid) {
    return {
      ok: false,
      error: staticError(
        "INVALID_SCHEMA",
        `Pipeline validation failed: ${pipelineResult.errors.join("; ")}`,
      ),
    };
  }

  // Determine output kind from last brick
  const lastBrick = bricks[bricks.length - 1];
  if (lastBrick === undefined) {
    return {
      ok: false,
      error: staticError("INVALID_SCHEMA", "No bricks loaded"),
    };
  }
  const outputKind: BrickKind =
    lastBrick.kind === "composite" ? lastBrick.outputKind : lastBrick.kind;

  // Exposed ports come from first and last steps
  const firstStep = steps[0];
  const lastStep = steps[steps.length - 1];
  if (firstStep === undefined || lastStep === undefined) {
    return {
      ok: false,
      error: staticError("INVALID_SCHEMA", "Pipeline steps are empty"),
    };
  }

  // Compute content-addressed pipeline ID (order-preserving)
  const stepIds = bricks.map((b) => b.id);
  const id = computePipelineBrickId(stepIds, outputKind, inputFiles);

  // Dedup check
  const existsResult = await deps.store.exists(id);
  if (existsResult.ok && existsResult.value) {
    const forgeResult: ForgeResult = {
      id,
      kind: "composite",
      name,
      descriptor: { name, description, inputSchema: {} },
      origin: "primordial",
      policy: deps.config.defaultPolicy ?? DEFAULT_SANDBOXED_POLICY,
      scope: deps.config.defaultScope,
      lifecycle: "active",
      verificationReport: {
        stages: [],
        sandbox: (deps.config.defaultPolicy ?? DEFAULT_SANDBOXED_POLICY).sandbox,
        totalDurationMs: 0,
        passed: true,
      },
      metadata: {
        forgedAt: Date.now(),
        forgedBy: deps.context.agentId,
        sessionId: deps.context.sessionId,
        depth: deps.context.depth,
      },
      forgesConsumed: 0,
    };
    return { ok: true, value: forgeResult };
  }

  const startedAt = Date.now();

  // Build the composite artifact
  const baseFields = buildBaseFields(
    id,
    {
      name,
      description,
      ...(tags !== undefined ? { tags } : {}),
      ...(trigger !== undefined ? { trigger } : {}),
      ...(inputFiles !== undefined ? { files: inputFiles } : {}),
    },
    {
      stages: [],
      sandbox: (deps.config.defaultPolicy ?? DEFAULT_SANDBOXED_POLICY).sandbox,
      totalDurationMs: 0,
      passed: true,
    },
    deps,
  );

  const provenance = getCreateProvenance(deps)({
    input: { kind: "composite", name, description, brickIds: parsed.value.brickIds },
    context: deps.context,
    report: {
      stages: [],
      sandbox: (deps.config.defaultPolicy ?? DEFAULT_SANDBOXED_POLICY).sandbox,
      totalDurationMs: 0,
      passed: true,
    },
    config: deps.config,
    contentHash: id,
    invocationId: id,
    startedAt,
    finishedAt: Date.now(),
  });

  const artifact: CompositeArtifact = {
    ...baseFields,
    kind: "composite",
    provenance,
    steps,
    exposedInput: firstStep.inputPort,
    exposedOutput: lastStep.outputPort,
    outputKind,
  };

  const saveResult = await deps.store.save(artifact);
  if (!saveResult.ok) {
    return {
      ok: false,
      error: {
        stage: "store",
        code: "SAVE_FAILED",
        message: `Failed to save composite artifact: ${saveResult.error.message}`,
      },
    };
  }

  // Fire-and-forget notification for cross-agent cache invalidation
  if (deps.notifier !== undefined) {
    void Promise.resolve(
      deps.notifier.notify({ kind: "saved", brickId: id, scope: deps.config.defaultScope }),
    ).catch((e: unknown) => {
      console.debug("[compose-forge] notifier.notify failed:", e);
    });
  }

  const forgeResult: ForgeResult = {
    id,
    kind: "composite",
    name,
    descriptor: { name, description, inputSchema: {} },
    origin: "primordial",
    policy: baseFields.policy,
    scope: baseFields.scope,
    lifecycle: "active",
    verificationReport: {
      stages: [],
      sandbox: baseFields.policy.sandbox,
      totalDurationMs: Date.now() - startedAt,
      passed: true,
    },
    metadata: {
      forgedAt: startedAt,
      forgedBy: deps.context.agentId,
      sessionId: deps.context.sessionId,
      depth: deps.context.depth,
    },
    forgesConsumed: 1,
  };

  return { ok: true, value: forgeResult };
}

// ---------------------------------------------------------------------------
// Port extraction helper
// ---------------------------------------------------------------------------

/**
 * Extract typed I/O ports from a brick based on its kind.
 */
function extractPorts(brick: BrickArtifact): {
  readonly inputPort: BrickPort;
  readonly outputPort: BrickPort;
} {
  switch (brick.kind) {
    case "tool":
      return {
        inputPort: { name: "input", schema: brick.inputSchema },
        outputPort: {
          name: "output",
          schema: brick.outputSchema ?? { type: "object" },
        },
      };
    case "skill":
      return {
        inputPort: { name: "input", schema: { type: "string" } },
        outputPort: { name: "output", schema: { type: "string" } },
      };
    case "agent":
      return {
        inputPort: { name: "input", schema: { type: "object" } },
        outputPort: { name: "output", schema: { type: "object" } },
      };
    case "middleware":
    case "channel":
      return {
        inputPort: { name: "input", schema: { type: "object" } },
        outputPort: { name: "output", schema: { type: "object" } },
      };
    case "composite":
      return {
        inputPort: brick.exposedInput,
        outputPort: brick.exposedOutput,
      };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createComposeForge(deps: ForgeDeps): Tool {
  return createForgeTool(COMPOSE_FORGE_CONFIG, deps);
}
