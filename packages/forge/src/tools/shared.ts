/**
 * Shared factory for primordial forge tools — DRY across all 6 tools.
 */

import type { JsonObject, Result, Tool, ToolDescriptor } from "@koi/core";
import type { ForgeConfig } from "../config.js";
import type { ForgeError } from "../errors.js";
import { staticError, typeError } from "../errors.js";
import { checkGovernance } from "../governance.js";
import type { ForgeStore } from "../store.js";
import type {
  BrickArtifact,
  ForgeContext,
  ForgeInput,
  ForgeResult,
  ForgeVerifier,
  ManifestParser,
  SandboxExecutor,
  VerificationReport,
} from "../types.js";
import { verify } from "../verify.js";

// ---------------------------------------------------------------------------
// Shared dependencies
// ---------------------------------------------------------------------------

export interface ForgeDeps {
  readonly store: ForgeStore;
  readonly executor: SandboxExecutor;
  readonly verifiers: readonly ForgeVerifier[];
  readonly config: ForgeConfig;
  readonly context: ForgeContext;
  /** Injected manifest parser — required only for forge_agent. Avoids L2 peer import of @koi/manifest. */
  readonly manifestParser?: ManifestParser;
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
// Runtime input validation
// ---------------------------------------------------------------------------

interface FieldSpec {
  readonly name: string;
  readonly type: "string" | "object" | "array";
  readonly required: boolean;
}

export function validateInputFields(
  input: unknown,
  fields: readonly FieldSpec[],
): ForgeError | undefined {
  if (input === null || typeof input !== "object") {
    return staticError("MISSING_FIELD", "Input must be a non-null object");
  }
  const obj = input as Record<string, unknown>;

  for (const field of fields) {
    const value = obj[field.name];
    if (field.required && value === undefined) {
      return staticError("MISSING_FIELD", `Missing required field: "${field.name}"`);
    }
    if (value !== undefined) {
      if (field.type === "string" && typeof value !== "string") {
        return typeError(`Field "${field.name}" must be a string, got ${typeof value}`);
      }
      if (field.type === "object" && (typeof value !== "object" || value === null)) {
        return typeError(`Field "${field.name}" must be an object, got ${typeof value}`);
      }
      if (field.type === "array" && !Array.isArray(value)) {
        return typeError(`Field "${field.name}" must be an array, got ${typeof value}`);
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Content hash (SHA-256 hex digest for integrity verification)
// ---------------------------------------------------------------------------

export function computeContentHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
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
  const verifyResult = await verify(
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
