/**
 * Shared factory for primordial forge tools — DRY across all 6 tools.
 */

import type { JsonObject, Result, Tool, ToolDescriptor } from "@koi/core";
import type { ForgeConfig } from "../config.js";
import type { ForgeError } from "../errors.js";
import { staticError } from "../errors.js";
import { checkGovernance } from "../governance.js";
import type { ForgeStore } from "../store.js";
import type { ForgeContext, ForgeVerifier, SandboxExecutor } from "../types.js";

// ---------------------------------------------------------------------------
// Shared dependencies
// ---------------------------------------------------------------------------

export interface ForgeDeps {
  readonly store: ForgeStore;
  readonly executor: SandboxExecutor;
  readonly verifiers: readonly ForgeVerifier[];
  readonly config: ForgeConfig;
  readonly context: ForgeContext;
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
        return staticError(
          "MISSING_FIELD",
          `Field "${field.name}" must be a string, got ${typeof value}`,
        );
      }
      if (field.type === "object" && (typeof value !== "object" || value === null)) {
        return staticError(
          "MISSING_FIELD",
          `Field "${field.name}" must be an object, got ${typeof value}`,
        );
      }
      if (field.type === "array" && !Array.isArray(value)) {
        return staticError(
          "MISSING_FIELD",
          `Field "${field.name}" must be an array, got ${typeof value}`,
        );
      }
    }
  }
  return undefined;
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
    // Governance pre-check
    const govResult = checkGovernance(deps.context, deps.config);
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
