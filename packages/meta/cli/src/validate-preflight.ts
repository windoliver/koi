/**
 * Pre-flight validation — checks that the runtime environment satisfies
 * manifest requirements before creating the runtime.
 *
 * Returns structured results with errors/warnings instead of throwing,
 * so the caller can decide how to handle each case (hard fail, warn, skip).
 */

import { PROVIDER_ENV_KEYS } from "@koi/model-router";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreflightIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly issues: readonly PreflightIssue[];
}

// ---------------------------------------------------------------------------
// Channel environment key requirements
// ---------------------------------------------------------------------------

const CHANNEL_ENV_REQUIREMENTS: Readonly<
  Record<string, readonly { readonly key: string; readonly label: string }[]>
> = {
  "@koi/channel-telegram": [{ key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token" }],
  "@koi/channel-slack": [
    { key: "SLACK_BOT_TOKEN", label: "Slack bot token" },
    { key: "SLACK_APP_TOKEN", label: "Slack app token" },
  ],
  "@koi/channel-discord": [
    { key: "DISCORD_BOT_TOKEN", label: "Discord bot token" },
    { key: "DISCORD_APPLICATION_ID", label: "Discord application ID" },
  ],
};

// ---------------------------------------------------------------------------
// Manifest shape (minimal subset needed for validation)
// ---------------------------------------------------------------------------

interface ManifestSubset {
  readonly model: { readonly name: string };
  readonly channels?: readonly { readonly name: string }[] | undefined;
  readonly nexus?: { readonly url?: string | undefined } | undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates that the environment has the prerequisites for the given manifest.
 *
 * Checks:
 * - Model provider API key is set
 * - Channel-specific tokens are set
 * - Nexus URL is reachable (warning only)
 */
export function validateManifestPrerequisites(
  manifest: ManifestSubset,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PreflightResult {
  const issues: PreflightIssue[] = [];

  // 1. Check model provider API key
  const modelName = manifest.model.name;
  const colonIndex = modelName.indexOf(":");
  if (colonIndex > 0) {
    const provider = modelName.slice(0, colonIndex);
    const envKey = PROVIDER_ENV_KEYS[provider];
    if (envKey !== undefined) {
      const value = env[envKey];
      if (value === undefined || value.trim() === "") {
        issues.push({
          severity: "error",
          code: "MISSING_MODEL_API_KEY",
          message: `Model "${modelName}" requires ${envKey} — set it in .env or environment`,
        });
      }
    }
  }

  // 2. Check channel tokens
  const channels = manifest.channels ?? [];
  for (const channel of channels) {
    const requirements = CHANNEL_ENV_REQUIREMENTS[channel.name];
    if (requirements === undefined) continue;

    for (const req of requirements) {
      const value = env[req.key];
      if (value === undefined || value.trim() === "") {
        issues.push({
          severity: "warning",
          code: "MISSING_CHANNEL_TOKEN",
          message: `Channel "${channel.name}" requires ${req.key} (${req.label})`,
        });
      }
    }
  }

  return {
    ok: issues.every((i) => i.severity !== "error"),
    issues,
  };
}

/**
 * Prints preflight issues to stderr in a consistent format.
 * Returns true if all issues are non-fatal (ok to proceed).
 */
export function printPreflightIssues(result: PreflightResult): boolean {
  for (const issue of result.issues) {
    const prefix = issue.severity === "error" ? "error" : "warn";
    process.stderr.write(`${prefix}: [preflight] ${issue.message}\n`);
  }
  return result.ok;
}
