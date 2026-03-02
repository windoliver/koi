/**
 * Shared factory for primordial forge tools — DRY across all 6 tools.
 */

import type {
  BrickArtifact,
  BrickArtifactBase,
  BrickId,
  ForgeStore,
  GovernanceController,
  JsonObject,
  Result,
  SigningBackend,
  StoreChangeNotifier,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import { computeBrickId } from "@koi/hash";
import { z } from "zod";
import { createForgeProvenance, signAttestation } from "../attestation.js";
import { extractBrickContent } from "../brick-content.js";
import type { ForgeConfig } from "../config.js";
import type { ForgeError } from "../errors.js";
import { staticError, typeError } from "../errors.js";
import { checkGovernance } from "../governance.js";
import { checkMutationPressure } from "../mutation-pressure-check.js";
import type {
  ForgeContext,
  ForgeInput,
  ForgeResult,
  ForgeVerifier,
  ManifestParser,
  TieredSandboxExecutor,
  VerificationReport,
} from "../types.js";
import { verify } from "../verify.js";

// ---------------------------------------------------------------------------
// Shared dependencies
// ---------------------------------------------------------------------------

export interface ForgeDeps {
  readonly store: ForgeStore;
  readonly executor: TieredSandboxExecutor;
  readonly verifiers: readonly ForgeVerifier[];
  readonly config: ForgeConfig;
  readonly context: ForgeContext;
  /** Injected manifest parser — required only for forge_agent. Avoids L2 peer import of @koi/manifest. */
  readonly manifestParser?: ManifestParser;
  /** Optional notifier for cross-agent cache invalidation after store mutations. */
  readonly notifier?: StoreChangeNotifier;
  /** Optional signing backend for attestation. When provided, forged bricks get cryptographic signatures. */
  readonly signer?: SigningBackend;
  /** Optional governance controller for live-counter budget checks (bypasses static ForgeContext.forgesThisSession). */
  readonly controller?: GovernanceController;
  /** Called after a successful forge with the number of forges consumed. When provided, incrementing the session counter is automatic. */
  readonly onForgeConsumed?: (consumed: number) => void | Promise<void>;
}

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
        readonly packages?: Readonly<Record<string, string>> | undefined;
        readonly network?: boolean | undefined;
      }
    | undefined;
  readonly configSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly classification?: "public" | "internal" | "secret" | undefined;
  readonly contentMarkers?: readonly ("credentials" | "pii" | "phi" | "payment")[] | undefined;
}

export interface ParsedToolInput extends ParsedBaseInput {
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown> | undefined;
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
      packages: z.record(z.string(), z.string()).optional(),
      network: z.boolean().optional(),
    })
    .optional(),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  classification: z.enum(["public", "internal", "secret"]).optional(),
  contentMarkers: z.array(z.enum(["credentials", "pii", "phi", "payment"])).optional(),
};

const forgeToolInputSchema = z.object({
  ...baseInputFields,
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
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
  },
  report: VerificationReport,
  deps: ForgeDeps,
): Omit<BrickArtifactBase, "kind" | "provenance"> {
  return {
    id,
    name: input.name,
    description: input.description,
    scope: deps.config.defaultScope,
    trustTier: report.finalTrustTier,
    lifecycle: "active",
    version: "0.0.1",
    tags: input.tags ?? [],
    usageCount: 0,
  };
}

/**
 * Compute a content-addressed BrickId for any artifact body (provenance not required).
 */
function computeArtifactId(artifact: Omit<BrickArtifact, "provenance">): BrickId {
  const { kind, content } = extractBrickContent(artifact);
  return computeBrickId(kind, content, artifact.files);
}

// ---------------------------------------------------------------------------
// Shared forge pipeline (verify → build artifact → compute ID → dedup → save → result)
// ---------------------------------------------------------------------------

/**
 * Builder returns a BrickArtifact body without provenance.
 * The `id` field will be a placeholder — the pipeline replaces it with
 * the content-addressed hash. Provenance is attached after signing.
 */
export type ArtifactBuilder = (
  report: VerificationReport,
  deps: ForgeDeps,
) => Omit<BrickArtifact, "provenance">;

export async function runForgePipeline(
  forgeInput: ForgeInput,
  deps: ForgeDeps,
  buildArtifact: ArtifactBuilder,
): Promise<Result<ForgeResult, ForgeError>> {
  const startedAt = Date.now();

  // Mutation pressure gate — block forge when capability space is frozen
  if (
    deps.config.mutationPressure?.enabled &&
    forgeInput.tags !== undefined &&
    forgeInput.tags.length > 0
  ) {
    const pressureResult = await checkMutationPressure(
      forgeInput.tags,
      deps.store,
      deps.config.mutationPressure,
      startedAt,
    );
    if (!pressureResult.ok) {
      return pressureResult;
    }
  }

  const { executor: sandboxExecutor } = deps.executor.forTier("sandbox");
  const verifyResult = await verify(
    forgeInput,
    deps.context,
    sandboxExecutor,
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
  const id = computeArtifactId(artifactBody);

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
      trustTier: report.finalTrustTier,
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
  let provenance = createForgeProvenance({
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
  });

  // Sign attestation if signer is available
  if (deps.signer !== undefined) {
    provenance = await signAttestation(provenance, deps.signer);
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
    ).catch(() => {});
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
    trustTier: report.finalTrustTier,
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
    const govResult = await checkGovernance(
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
      await Promise.resolve(deps.onForgeConsumed(result.value.forgesConsumed)).catch(() => {});
    }

    return result;
  };

  return {
    descriptor,
    trustTier: "promoted", // Primordial tools are first-party
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
