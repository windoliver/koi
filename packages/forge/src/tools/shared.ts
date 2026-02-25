/**
 * Shared factory for primordial forge tools — DRY across all 6 tools.
 */

import type {
  BrickArtifact,
  BrickArtifactBase,
  ForgeStore,
  JsonObject,
  Result,
  StoreChangeNotifier,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import { z } from "zod";
import type { ForgeConfig } from "../config.js";
import type { ForgeError } from "../errors.js";
import { staticError, typeError } from "../errors.js";
import { checkGovernance } from "../governance.js";
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
      }
    | undefined;
  readonly configSchema?: Readonly<Record<string, unknown>> | undefined;
}

export interface ParsedToolInput extends ParsedBaseInput {
  readonly inputSchema: Record<string, unknown>;
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
    })
    .optional(),
  configSchema: z.record(z.string(), z.unknown()).optional(),
};

const forgeToolInputSchema = z.object({
  ...baseInputFields,
  inputSchema: z.record(z.string(), z.unknown()),
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

export function buildBaseFields(
  id: string,
  input: {
    readonly name: string;
    readonly description: string;
    readonly tags?: readonly string[];
  },
  report: VerificationReport,
  deps: ForgeDeps,
  contentHash: string,
): Omit<BrickArtifactBase, "kind"> {
  return {
    id,
    name: input.name,
    description: input.description,
    scope: deps.config.defaultScope,
    trustTier: report.finalTrustTier,
    lifecycle: "active",
    createdBy: deps.context.agentId,
    createdAt: Date.now(),
    version: "0.0.1",
    tags: input.tags ?? [],
    usageCount: 0,
    contentHash,
  };
}

// ---------------------------------------------------------------------------
// Content hash (SHA-256 hex digest for integrity verification)
// ---------------------------------------------------------------------------

export function computeContentHash(
  content: string,
  files?: Readonly<Record<string, string>>,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  if (files !== undefined) {
    const sortedKeys = Object.keys(files).sort();
    for (const key of sortedKeys) {
      hasher.update(key);
      const value = files[key];
      if (value !== undefined) {
        hasher.update(value);
      }
    }
  }
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// Shared forge pipeline (verify → generate ID → build artifact → save → result)
// ---------------------------------------------------------------------------

export type ArtifactBuilder = (
  id: string,
  report: VerificationReport,
  deps: ForgeDeps,
) => BrickArtifact;

export async function runForgePipeline(
  forgeInput: ForgeInput,
  deps: ForgeDeps,
  buildArtifact: ArtifactBuilder,
): Promise<Result<ForgeResult, ForgeError>> {
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
  const id = `brick_${crypto.randomUUID()}`;

  const artifact = buildArtifact(id, report, deps);

  const saveResult = await deps.store.save(artifact);
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
      forgedAt: artifact.createdAt,
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
    const govResult = checkGovernance(deps.context, deps.config, toolConfig.name);
    if (!govResult.ok) {
      return { ok: false, error: govResult.error };
    }

    // Delegate to handler
    return toolConfig.handler(input, deps);
  };

  return {
    descriptor,
    trustTier: "promoted", // Primordial tools are first-party
    execute,
  };
}
