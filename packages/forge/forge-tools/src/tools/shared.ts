/**
 * Shared factory for primordial forge tools — DRY across all 6 tools.
 */

import type {
  BrickArtifact,
  BrickArtifactBase,
  BrickId,
  BrickRequires,
  EvolutionKind,
  JsonObject,
  Result,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type {
  ArtifactBuilder,
  DelegateOptions,
  ForgeDeps,
  ForgeError,
  ForgeInput,
  ForgePipeline,
  ForgeResult,
  VerificationReport,
} from "@koi/forge-types";
import { staticError, typeError } from "@koi/forge-types";
import { computeBrickId } from "@koi/hash";
import { credentialRequiresSchema } from "@koi/validation";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Pipeline requirement helper — L2 packages use pipeline for cross-L2 calls
// ---------------------------------------------------------------------------

/**
 * Retrieves the ForgePipeline from deps, throwing if not provided.
 *
 * In @koi/forge-tools (L2), cross-package calls (verify, governance,
 * attestation) go through the injected ForgePipeline. The L3 bundle
 * (@koi/forge) wires this via createForgePipeline().
 */
function requirePipeline(deps: ForgeDeps): ForgePipeline {
  if (deps.pipeline === undefined) {
    throw new Error(
      "ForgePipeline is required in @koi/forge-tools — provide via createForgePipeline() from @koi/forge",
    );
  }
  return deps.pipeline;
}

// ---------------------------------------------------------------------------
// Shared dependencies — re-exported from @koi/forge-types for backward compat
// ---------------------------------------------------------------------------

// ForgeDeps + DelegateOptions are canonical in @koi/forge-types (L0u).
// Re-export here so existing consumers of @koi/forge-tools don't break.
export type { DelegateOptions, ForgeDeps } from "@koi/forge-types";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ForgeToolConfig {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly handler: (input: unknown, deps: ForgeDeps) => Promise<Result<unknown, ForgeError>>;
}

// ---------------------------------------------------------------------------
// Parsed input types — explicit for isolatedDeclarations (.d.ts generation)
// ---------------------------------------------------------------------------

export interface ParsedBaseInput {
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[] | undefined;
  readonly files?: Readonly<Record<string, string>> | undefined;
  readonly requires?:
    | {
        readonly bins?: readonly string[] | undefined;
        readonly env?: readonly string[] | undefined;
        readonly tools?: readonly string[] | undefined;
        readonly agents?: readonly string[] | undefined;
        readonly packages?: Readonly<Record<string, string>> | undefined;
        readonly network?: boolean | undefined;
        readonly credentials?:
          | Readonly<
              Record<
                string,
                {
                  readonly kind: string;
                  readonly ref: string;
                  readonly scopes?: readonly string[] | undefined;
                }
              >
            >
          | undefined;
      }
    | undefined;
  readonly configSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly classification?: "public" | "internal" | "secret" | undefined;
  readonly contentMarkers?: readonly ("credentials" | "pii" | "phi" | "payment")[] | undefined;
  readonly trigger?: readonly string[] | undefined;
  readonly parentBrickId?: string | undefined;
  readonly evolutionKind?: "fix" | "derived" | "captured" | undefined;
}

export interface ParsedToolInput extends ParsedBaseInput {
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown> | undefined;
  readonly implementation?: string | undefined;
  readonly testCases?:
    | readonly {
        readonly name: string;
        readonly input: unknown;
        readonly expectedOutput?: unknown | undefined;
        readonly shouldThrow?: boolean | undefined;
      }[]
    | undefined;
  readonly delegateTo?: string | undefined;
  readonly delegateOptions?: DelegateOptions | undefined;
}

export interface ParsedSkillInput extends ParsedBaseInput {
  readonly body: string;
}

export interface ParsedAgentInput extends ParsedBaseInput {
  readonly manifestYaml?: string | undefined;
  readonly brickIds?: readonly string[] | undefined;
  readonly model?: string | undefined;
  readonly agentType?: string | undefined;
}

export interface ParsedCompositeInput extends ParsedBaseInput {
  readonly brickIds: readonly string[];
}

export interface ParsedImplementationInput extends ParsedBaseInput {
  readonly implementation: string;
  readonly testCases?:
    | readonly {
        readonly name: string;
        readonly input: unknown;
        readonly expectedOutput?: unknown | undefined;
        readonly shouldThrow?: boolean | undefined;
      }[]
    | undefined;
}

// ---------------------------------------------------------------------------
// Zod input schemas
// ---------------------------------------------------------------------------

const baseInputFields = {
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).optional(),
  files: z.record(z.string(), z.string()).optional(),
  requires: z
    .object({
      bins: z.array(z.string()).optional(),
      env: z.array(z.string()).optional(),
      tools: z.array(z.string()).optional(),
      agents: z.array(z.string()).optional(),
      packages: z.record(z.string(), z.string()).optional(),
      network: z.boolean().optional(),
      credentials: credentialRequiresSchema.optional(),
    })
    .optional(),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  classification: z.enum(["public", "internal", "secret"]).optional(),
  contentMarkers: z.array(z.enum(["credentials", "pii", "phi", "payment"])).optional(),
  trigger: z.array(z.string()).optional(),
  parentBrickId: z.string().optional(),
  evolutionKind: z.enum(["fix", "derived", "captured"]).optional(),
};

const forgeToolInputSchema = z.object({
  ...baseInputFields,
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  implementation: z.string().optional(),
  testCases: z
    .array(
      z.object({
        name: z.string(),
        input: z.unknown(),
        expectedOutput: z.unknown().optional(),
        shouldThrow: z.boolean().optional(),
      }),
    )
    .optional(),
  delegateTo: z.string().optional(),
  delegateOptions: z
    .object({
      model: z.string().optional(),
      timeoutMs: z.number().min(1_000).max(600_000).optional(),
      retries: z.number().int().min(0).max(10).optional(),
    })
    .optional(),
});

const forgeSkillInputSchema = z.object({
  ...baseInputFields,
  body: z.string(),
});

const forgeAgentInputSchema = z
  .object({
    ...baseInputFields,
    manifestYaml: z.string().optional(),
    brickIds: z.array(z.string()).optional(),
    model: z.string().optional(),
    agentType: z.string().optional(),
  })
  .refine((val) => (val.manifestYaml !== undefined) !== (val.brickIds !== undefined), {
    message: "Exactly one of manifestYaml or brickIds must be provided",
  });

const forgeCompositeInputSchema = z.object({
  ...baseInputFields,
  brickIds: z.array(z.string()),
});

const forgeImplementationInputSchema = z.object({
  ...baseInputFields,
  implementation: z.string(),
  testCases: z
    .array(
      z.object({
        name: z.string(),
        input: z.unknown(),
        expectedOutput: z.unknown().optional(),
        shouldThrow: z.boolean().optional(),
      }),
    )
    .optional(),
});

// ---------------------------------------------------------------------------
// Typed parse functions — replaces exported schemas for isolatedDeclarations
// ---------------------------------------------------------------------------

function zodParse<T>(schema: z.ZodType<T>, input: unknown): Result<T, ForgeError> {
  if (input === null || typeof input !== "object") {
    return { ok: false, error: staticError("MISSING_FIELD", "Input must be a non-null object") };
  }
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const firstIssue = result.error.issues[0];
  if (firstIssue === undefined) {
    return { ok: false, error: staticError("INVALID_SCHEMA", "Input validation failed") };
  }
  const fieldPath = firstIssue.path.join(".");
  if (firstIssue.code === "invalid_type") {
    // Zod v4: `received` is not a top-level field; detect from message
    const isMissing = firstIssue.message.includes("received undefined");
    if (isMissing) {
      return {
        ok: false,
        error: staticError("MISSING_FIELD", `Missing required field: "${fieldPath}"`),
      };
    }
    // Extract received type from message: "expected string, received number"
    const receivedMatch = /received (\w+)/.exec(firstIssue.message);
    const received = receivedMatch?.[1] ?? "unknown";
    return {
      ok: false,
      error: typeError(`Field "${fieldPath}" must be a ${firstIssue.expected}, got ${received}`),
    };
  }
  if (firstIssue.code === "custom") {
    return {
      ok: false,
      error: staticError("INVALID_SCHEMA", firstIssue.message ?? "Validation failed"),
    };
  }
  return {
    ok: false,
    error: staticError(
      "INVALID_SCHEMA",
      `Validation error at "${fieldPath}": ${firstIssue.message}`,
    ),
  };
}

/** @deprecated Use parseToolInput/parseSkillInput/parseAgentInput/parseCompositeInput instead */
export function parseForgeInput<T>(schema: z.ZodType<T>, input: unknown): Result<T, ForgeError> {
  return zodParse(schema, input);
}

export function parseToolInput(input: unknown): Result<ParsedToolInput, ForgeError> {
  return zodParse(forgeToolInputSchema, input);
}

export function parseSkillInput(input: unknown): Result<ParsedSkillInput, ForgeError> {
  return zodParse(forgeSkillInputSchema, input);
}

export function parseAgentInput(input: unknown): Result<ParsedAgentInput, ForgeError> {
  return zodParse(forgeAgentInputSchema, input);
}

export function parseCompositeInput(input: unknown): Result<ParsedCompositeInput, ForgeError> {
  return zodParse(forgeCompositeInputSchema, input);
}

export function parseImplementationInput(
  input: unknown,
): Result<ParsedImplementationInput, ForgeError> {
  return zodParse(forgeImplementationInputSchema, input);
}

// ---------------------------------------------------------------------------
// DRY helpers for parsed → ForgeInput mapping
// ---------------------------------------------------------------------------

/**
 * Maps parsed test cases into the ForgeInput test case shape.
 * Strips undefined optional fields to match exactOptionalPropertyTypes.
 */
export function mapParsedTestCases(
  testCases:
    | readonly {
        readonly name: string;
        readonly input: unknown;
        readonly expectedOutput?: unknown | undefined;
        readonly shouldThrow?: boolean | undefined;
      }[]
    | undefined,
):
  | readonly {
      readonly name: string;
      readonly input: unknown;
      readonly expectedOutput?: unknown;
      readonly shouldThrow?: boolean;
    }[]
  | undefined {
  if (testCases === undefined) return undefined;
  return testCases.map((tc) => ({
    name: tc.name,
    input: tc.input,
    ...(tc.expectedOutput !== undefined ? { expectedOutput: tc.expectedOutput } : {}),
    ...(tc.shouldThrow !== undefined ? { shouldThrow: tc.shouldThrow } : {}),
  }));
}

/**
 * Extracts common ForgeInput base fields from a parsed input.
 * DRYs the requires/tags/files/classification/contentMarkers spread
 * that was duplicated in every tool handler.
 */
export function mapParsedBaseFields(parsed: ParsedBaseInput): {
  readonly tags?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
  readonly requires?: {
    readonly bins?: readonly string[];
    readonly env?: readonly string[];
    readonly tools?: readonly string[];
    readonly agents?: readonly string[];
    readonly packages?: Readonly<Record<string, string>>;
    readonly network?: boolean;
    readonly credentials?: Readonly<
      Record<
        string,
        {
          readonly kind: string;
          readonly ref: string;
          readonly scopes?: readonly string[];
        }
      >
    >;
  };
  readonly configSchema?: Readonly<Record<string, unknown>>;
  readonly classification?: "public" | "internal" | "secret";
  readonly contentMarkers?: readonly ("credentials" | "pii" | "phi" | "payment")[];
  readonly trigger?: readonly string[];
  readonly parentBrickId?: BrickId;
  readonly evolutionKind?: EvolutionKind;
} {
  return {
    ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
    ...(parsed.files !== undefined ? { files: parsed.files } : {}),
    ...(parsed.requires !== undefined
      ? {
          requires: {
            ...(parsed.requires.bins !== undefined ? { bins: parsed.requires.bins } : {}),
            ...(parsed.requires.env !== undefined ? { env: parsed.requires.env } : {}),
            ...(parsed.requires.tools !== undefined ? { tools: parsed.requires.tools } : {}),
            ...(parsed.requires.agents !== undefined ? { agents: parsed.requires.agents } : {}),
            ...(parsed.requires.packages !== undefined
              ? { packages: parsed.requires.packages }
              : {}),
            ...(parsed.requires.network !== undefined ? { network: parsed.requires.network } : {}),
            ...(parsed.requires.credentials !== undefined
              ? {
                  credentials: Object.fromEntries(
                    Object.entries(parsed.requires.credentials).map(([k, v]) => [
                      k,
                      {
                        kind: v.kind,
                        ref: v.ref,
                        ...(v.scopes !== undefined ? { scopes: v.scopes } : {}),
                      },
                    ]),
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(parsed.configSchema !== undefined ? { configSchema: parsed.configSchema } : {}),
    ...(parsed.classification !== undefined ? { classification: parsed.classification } : {}),
    ...(parsed.contentMarkers !== undefined ? { contentMarkers: parsed.contentMarkers } : {}),
    ...(parsed.trigger !== undefined ? { trigger: parsed.trigger } : {}),
    ...(parsed.parentBrickId !== undefined ? { parentBrickId: brickId(parsed.parentBrickId) } : {}),
    ...(parsed.evolutionKind !== undefined ? { evolutionKind: parsed.evolutionKind } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared base fields builder (DRY artifact construction)
// ---------------------------------------------------------------------------

/**
 * Builds the shared base fields for all brick artifacts (without provenance).
 *
 * Provenance is attached by `runForgePipeline` after verification + signing,
 * avoiding a wasteful placeholder that was always overwritten.
 */
export function buildBaseFields(
  id: BrickId,
  input: {
    readonly name: string;
    readonly description: string;
    readonly tags?: readonly string[];
    readonly trigger?: readonly string[];
    readonly files?: Readonly<Record<string, string>>;
    readonly requires?: BrickRequires;
    readonly configSchema?: Readonly<Record<string, unknown>>;
  },
  report: VerificationReport,
  deps: ForgeDeps,
): Omit<BrickArtifactBase, "kind" | "provenance"> {
  return {
    id,
    name: input.name,
    description: input.description,
    scope: deps.config.defaultScope,
    origin: "forged",
    policy: report.sandbox ? DEFAULT_SANDBOXED_POLICY : DEFAULT_UNSANDBOXED_POLICY,
    lifecycle: "active",
    version: "0.0.1",
    tags: input.tags ?? [],
    usageCount: 0,
    ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
    ...(input.files !== undefined ? { files: input.files } : {}),
    ...(input.requires !== undefined ? { requires: input.requires } : {}),
    ...(input.configSchema !== undefined ? { configSchema: input.configSchema } : {}),
  };
}

/**
 * Compute a content-addressed BrickId for any artifact body (provenance not required).
 */
function computeArtifactId(
  artifact: Omit<BrickArtifact, "provenance">,
  pipeline: ForgePipeline,
): BrickId {
  const { kind, content } = pipeline.extractBrickContent(artifact);
  return computeBrickId(kind, content, artifact.files);
}

// ---------------------------------------------------------------------------
// Shared forge pipeline (verify → build artifact → compute ID → dedup → save → result)
// ---------------------------------------------------------------------------

// ArtifactBuilder canonical definition is in @koi/forge-types.
// Re-export for backward compat.
export type { ArtifactBuilder } from "@koi/forge-types";

export async function runForgePipeline(
  forgeInput: ForgeInput,
  deps: ForgeDeps,
  buildArtifact: ArtifactBuilder,
): Promise<Result<ForgeResult, ForgeError>> {
  const startedAt = Date.now();

  const pipeline = requirePipeline(deps);

  // Mutation pressure gate — block forge when capability space is frozen
  if (
    deps.config.mutationPressure?.enabled &&
    forgeInput.tags !== undefined &&
    forgeInput.tags.length > 0
  ) {
    const pressureResult = await pipeline.checkMutationPressure(
      forgeInput.tags,
      deps.store,
      deps.config.mutationPressure,
      startedAt,
    );
    if (!pressureResult.ok) {
      return pressureResult;
    }
  }

  // Name-based dedup: prevent duplicate bricks with the same name.
  // Checked before verification to save compute on known duplicates.
  // Content dedup (hash, checked post-verify) misses bricks with slightly
  // different implementations that serve the same logical purpose.
  // Edits skip both dedup checks — they intentionally create a new brick with the same name.
  if (!options?.skipDedup) {
    const nameSearchResult = await deps.store.search({
      text: forgeInput.name,
      kind: forgeInput.kind,
      lifecycle: "active",
      limit: 5,
    });
    if (nameSearchResult.ok && nameSearchResult.value.some((b) => b.name === forgeInput.name)) {
      const existing = nameSearchResult.value.find((b) => b.name === forgeInput.name);
      if (existing !== undefined) {
        const forgeResult: ForgeResult = {
          id: existing.id,
          kind: forgeInput.kind,
          name: forgeInput.name,
          descriptor: {
            name: forgeInput.name,
            description: forgeInput.description,
            inputSchema: forgeInput.kind === "tool" ? forgeInput.inputSchema : {},
          },
          origin: "forged",
          policy: existing.policy,
          scope: deps.config.defaultScope,
          lifecycle: "active",
          verificationReport: {
            passed: true,
            sandbox: existing.policy.sandbox,
            totalDurationMs: 0,
            stages: [],
          },
          metadata: {
            forgedAt: startedAt,
            forgedBy: deps.context.agentId,
            sessionId: deps.context.sessionId,
            depth: deps.context.depth,
          },
          forgesConsumed: 0,
        };
        return { ok: true, value: forgeResult };
      }
    }
  }

  const verifyResult = await pipeline.verify(
    forgeInput,
    deps.context,
    deps.executor,
    deps.verifiers,
    deps.config,
  );

  if (!verifyResult.ok) {
    return { ok: false, error: verifyResult.error };
  }

  const report = verifyResult.value;

  // Builder returns artifact body without provenance — we'll add it after signing
  const artifactBody = buildArtifact(report, deps);

  // Compute content-addressed ID
  const id = computeArtifactId(artifactBody, pipeline);

  // Replace placeholder id with content-addressed id
  const artifactWithId = { ...artifactBody, id };

  // Dedup check: if brick with this ID already exists, return early
  const existsResult = await deps.store.exists(id);
  if (existsResult.ok && existsResult.value) {
    const forgeResult: ForgeResult = {
      id,
      kind: forgeInput.kind,
      name: forgeInput.name,
      descriptor: {
        name: forgeInput.name,
        description: forgeInput.description,
        inputSchema: forgeInput.kind === "tool" ? forgeInput.inputSchema : {},
      },
      origin: "forged",
      policy: report.sandbox ? DEFAULT_SANDBOXED_POLICY : DEFAULT_UNSANDBOXED_POLICY,
      scope: deps.config.defaultScope,
      lifecycle: "active",
      verificationReport: report,
      metadata: {
        forgedAt: startedAt,
        forgedBy: deps.context.agentId,
        sessionId: deps.context.sessionId,
        depth: deps.context.depth,
      },
      forgesConsumed: 0,
    };
    return { ok: true, value: forgeResult };
  }

  const finishedAt = Date.now();

  // Build provenance from pipeline outputs
  // let justified: provenance may be signed in-place below
  let provenance = pipeline.createProvenance({
    input: forgeInput,
    context: deps.context,
    report,
    config: deps.config,
    contentHash: id, // Content-addressed ID IS the hash
    invocationId: id,
    startedAt,
    finishedAt,
    ...(forgeInput.classification !== undefined
      ? { classification: forgeInput.classification }
      : {}),
    ...(forgeInput.contentMarkers !== undefined
      ? { contentMarkers: forgeInput.contentMarkers }
      : {}),
    ...(forgeInput.parentBrickId !== undefined ? { parentBrickId: forgeInput.parentBrickId } : {}),
    ...(forgeInput.evolutionKind !== undefined ? { evolutionKind: forgeInput.evolutionKind } : {}),
  });

  // Sign attestation if signer is available
  if (deps.signer !== undefined) {
    provenance = await pipeline.signAttestation(provenance, deps.signer);
  }

  // Justified `as BrickArtifact`: reconstructing the exact union variant by adding back
  // the `provenance` field that was omitted from the builder return type. TypeScript cannot
  // prove that Omit<UnionType, "provenance"> & { provenance } reconstitutes the union.
  const artifactWithProvenance = {
    ...artifactWithId,
    provenance,
  } as BrickArtifact;

  const saveResult = await deps.store.save(artifactWithProvenance);
  if (!saveResult.ok) {
    return {
      ok: false,
      error: {
        stage: "store",
        code: "SAVE_FAILED",
        message: `Failed to save artifact: ${saveResult.error.message}`,
      },
    };
  }

  // Fire-and-forget notification for cross-agent cache invalidation
  if (deps.notifier !== undefined) {
    void Promise.resolve(
      deps.notifier.notify({ kind: "saved", brickId: id, scope: deps.config.defaultScope }),
    ).catch((e: unknown) => {
      if (deps.onError !== undefined) {
        deps.onError(e);
      } else {
        console.debug("[forge] notifier.notify failed:", e);
      }
    });
  }

  const forgeResult: ForgeResult = {
    id,
    kind: forgeInput.kind,
    name: forgeInput.name,
    descriptor: {
      name: forgeInput.name,
      description: forgeInput.description,
      inputSchema: forgeInput.kind === "tool" ? forgeInput.inputSchema : {},
    },
    origin: "forged",
    policy: report.sandbox ? DEFAULT_SANDBOXED_POLICY : DEFAULT_UNSANDBOXED_POLICY,
    scope: deps.config.defaultScope,
    lifecycle: "active",
    verificationReport: report,
    metadata: {
      forgedAt: provenance.metadata.startedAt,
      forgedBy: deps.context.agentId,
      sessionId: deps.context.sessionId,
      depth: deps.context.depth,
    },
    forgesConsumed: 1,
  };

  return { ok: true, value: forgeResult };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createForgeTool(toolConfig: ForgeToolConfig, deps: ForgeDeps): Tool {
  const descriptor: ToolDescriptor = {
    name: toolConfig.name,
    description: toolConfig.description,
    inputSchema: toolConfig.inputSchema,
  };

  const execute = async (input: JsonObject): Promise<unknown> => {
    // Governance pre-check (includes depth-aware tool filtering)
    const pipeline = requirePipeline(deps);
    const govResult = await pipeline.checkGovernance(
      deps.context,
      deps.config,
      toolConfig.name,
      deps.controller,
    );
    if (!govResult.ok) {
      return { ok: false, error: govResult.error };
    }

    // Delegate to handler
    const result = await toolConfig.handler(input, deps);

    // Increment engine-owned counter when a new brick was forged.
    // Treat counter update failure as non-fatal — the brick is already saved.
    if (deps.onForgeConsumed !== undefined && isForgeConsumed(result)) {
      await Promise.resolve(deps.onForgeConsumed(result.value.forgesConsumed)).catch(
        (e: unknown) => {
          console.debug("[forge] onForgeConsumed callback failed:", e);
        },
      );
    }

    return result;
  };

  return {
    descriptor,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY, // Primordial tools are first-party
    execute,
  };
}

// ---------------------------------------------------------------------------
// Type guard for forge result with consumed count
// ---------------------------------------------------------------------------

/**
 * Narrows unknown handler result to a successful forge with forgesConsumed > 0.
 * Dedup (already-stored brick) returns forgesConsumed: 0 and is intentionally excluded.
 */
function isForgeConsumed(
  result: unknown,
): result is { readonly ok: true; readonly value: { readonly forgesConsumed: number } } {
  if (result === null || typeof result !== "object") return false;
  if (!("ok" in result) || result.ok !== true) return false;
  if (!("value" in result) || result.value === null || typeof result.value !== "object")
    return false;
  const v: object = result.value;
  if (!("forgesConsumed" in v)) return false;
  const fc = (v as { readonly forgesConsumed: unknown }).forgesConsumed;
  return typeof fc === "number" && fc > 0;
}
