/**
 * External agent delegation — delegates implementation authoring to an
 * external coding agent (Claude Code, Codex, etc.) while retaining the
 * full Forge verification pipeline.
 */

import type { Result } from "@koi/core";
import type { ForgeError, ForgeToolInput } from "@koi/forge-types";
import { delegationError } from "@koi/forge-types";
import type { DelegateOptions, ForgeDeps } from "./shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRIES = 0;

// ---------------------------------------------------------------------------
// Prompt generation (pure)
// ---------------------------------------------------------------------------

/**
 * Builds a coding prompt from the forge input so an external agent
 * knows exactly what interface to implement.
 */
export function generateDelegationPrompt(input: ForgeToolInput): string {
  const lines: readonly string[] = [
    `Implement a tool function named "${input.name}".`,
    "",
    `Description: ${input.description}`,
    "",
    "Input schema (JSON Schema):",
    JSON.stringify(input.inputSchema, null, 2),
    "",
    "The function receives `input` matching the schema above and must return a value.",
    "Return ONLY the function body as a string (no wrapping function declaration).",
    ...(input.testCases !== undefined && input.testCases.length > 0
      ? [
          "",
          "Test cases the implementation must satisfy:",
          ...input.testCases.map(
            (tc, i) =>
              `  ${String(i + 1)}. ${tc.name}: input=${JSON.stringify(tc.input)}${tc.expectedOutput !== undefined ? `, expected=${JSON.stringify(tc.expectedOutput)}` : ""}${tc.shouldThrow === true ? " (should throw)" : ""}`,
          ),
        ]
      : []),
    ...(input.outputSchema !== undefined
      ? ["", "Output schema (JSON Schema):", JSON.stringify(input.outputSchema, null, 2)]
      : []),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Delegation orchestrator
// ---------------------------------------------------------------------------

/**
 * Delegates implementation authoring to an external coding agent.
 *
 * - Validates that DI callbacks are present
 * - Discovers the agent by name
 * - Generates a coding prompt
 * - Retry loop with per-attempt timeout
 * - Returns implementation string or ForgeError
 */
export async function delegateImplementation(
  agentName: string,
  input: ForgeToolInput,
  deps: ForgeDeps,
  options?: DelegateOptions,
): Promise<Result<string, ForgeError>> {
  if (deps.discoverAgent === undefined || deps.spawnCodingAgent === undefined) {
    return {
      ok: false,
      error: delegationError(
        "DELEGATION_FAILED",
        "Delegation requires discoverAgent and spawnCodingAgent callbacks in ForgeDeps",
      ),
    };
  }

  const discoverResult = await deps.discoverAgent(agentName);
  if (!discoverResult.ok) {
    return {
      ok: false,
      error: delegationError(
        "AGENT_NOT_FOUND",
        `External agent "${agentName}" not found: ${discoverResult.error.message}`,
      ),
    };
  }

  const agent = discoverResult.value;
  const prompt = generateDelegationPrompt(input);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options?.retries ?? DEFAULT_RETRIES;
  const resolvedOptions: DelegateOptions = {
    ...(options?.model !== undefined ? { model: options.model } : {}),
    timeoutMs,
    retries,
  };

  // let justified: lastError tracks the most recent failure for the exhaustion message
  let lastError: ForgeError = delegationError(
    "DELEGATION_FAILED",
    `Delegation to "${agentName}" failed before first attempt`,
  );

  for (let attempt = 0; attempt <= retries; attempt++) {
    const spawnResult = await deps.spawnCodingAgent(agent, prompt, resolvedOptions);
    if (spawnResult.ok) {
      return { ok: true, value: spawnResult.value };
    }

    const isTimeout = spawnResult.error.code === "TIMEOUT";
    lastError = delegationError(
      isTimeout ? "DELEGATION_TIMEOUT" : "DELEGATION_FAILED",
      `Delegation attempt ${String(attempt + 1)}/${String(retries + 1)} failed: ${spawnResult.error.message}`,
    );
  }

  if (retries > 0) {
    return {
      ok: false,
      error: delegationError(
        "DELEGATION_RETRIES_EXHAUSTED",
        `All ${String(retries + 1)} delegation attempts failed. Last error: ${lastError.message}`,
      ),
    };
  }

  return { ok: false, error: lastError };
}
