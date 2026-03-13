/**
 * PREFLIGHT phase — validate prerequisites with interactive recovery.
 *
 * When running in a TTY, offers fix-it prompts for common errors
 * (e.g., missing API key). In non-TTY mode, fails with a hint
 * to run `koi doctor --repair`.
 */

import type { CliOutput } from "@koi/cli-render";
import type { AgentManifest } from "@koi/core";
import type { PreflightResult as ValidatorResult } from "../../validate-preflight.js";
import { printPreflightIssues, validateManifestPrerequisites } from "../../validate-preflight.js";

export interface PreflightOptions {
  readonly manifest: AgentManifest;
  readonly env: NodeJS.ProcessEnv;
  readonly temporalRequired: boolean;
  readonly output: CliOutput;
}

export interface PreflightResult {
  readonly passed: boolean;
}

/**
 * Runs preflight checks. If running in TTY and a missing API key is detected,
 * offers an interactive prompt to set it.
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const { manifest, env, temporalRequired, output } = options;

  const preflight = await validateManifestPrerequisites(manifest, env, {
    temporalRequired,
  });

  if (printPreflightIssues(preflight)) {
    return { passed: true };
  }

  // Interactive recovery: offer to set missing API key
  if (output.isTTY) {
    const missingKey = findMissingApiKey(preflight);
    if (missingKey !== undefined) {
      const recovered = await promptForApiKey(missingKey, env, output);
      if (recovered) {
        // Re-run preflight after fix
        const retry = await validateManifestPrerequisites(manifest, env, {
          temporalRequired,
        });
        if (printPreflightIssues(retry)) {
          return { passed: true };
        }
      }
    }
  }

  output.error(
    "Preflight checks failed. Fix errors above and retry.",
    "run `koi doctor --repair` to auto-fix common issues",
  );
  return { passed: false };
}

// ---------------------------------------------------------------------------
// Interactive recovery helpers
// ---------------------------------------------------------------------------

/**
 * Searches preflight issues for a missing API key error.
 * Matches the MISSING_MODEL_API_KEY code from validate-preflight.ts
 * and extracts the env var name (e.g., OPENAI_API_KEY, ANTHROPIC_API_KEY).
 */
function findMissingApiKey(result: ValidatorResult): string | undefined {
  for (const issue of result.issues) {
    if (issue.code === "MISSING_MODEL_API_KEY") {
      // Extract the env var name: "Model ... requires OPENAI_API_KEY — set it..."
      const match = /requires\s+(\w+_API_KEY)/i.exec(issue.message);
      if (match?.[1] !== undefined) return match[1];
    }
  }
  return undefined;
}

async function promptForApiKey(
  keyName: string,
  env: NodeJS.ProcessEnv,
  output: CliOutput,
): Promise<boolean> {
  try {
    const p = await import("@clack/prompts");
    const value = await p.text({
      message: `${keyName} not set. Enter it now?`,
      placeholder: "sk-...",
      validate: (v) => (v.trim() === "" ? "Key cannot be empty" : undefined),
    });

    if (p.isCancel(value)) return false;

    env[keyName] = value as string;
    output.success(`${keyName} set for this session`);
    return true;
  } catch {
    return false;
  }
}
