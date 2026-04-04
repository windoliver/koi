/**
 * Default deny rules for sensitive credential directories and files.
 *
 * These rules block filesystem access to directories known to contain
 * secrets (SSH keys, cloud credentials, GPG keys, etc.) at the policy
 * level — the highest precedence, cannot be overridden by user/project rules.
 */

import type { PermissionRule, RuleSource, SourcedRule } from "./rule-types.js";

/**
 * Default credential deny rules. Each rule denies all actions on a
 * sensitive directory or file pattern. Apply at "policy" source level
 * for maximum precedence.
 */
export const CREDENTIAL_DENY_RULES: readonly PermissionRule[] = [
  {
    pattern: "**/.ssh/**",
    action: "*",
    effect: "deny",
    reason: "SSH keys — credential directory blocked by default policy",
  },
  {
    pattern: "**/.docker/**",
    action: "*",
    effect: "deny",
    reason: "Docker credentials — credential directory blocked by default policy",
  },
  {
    pattern: "**/.aws/**",
    action: "*",
    effect: "deny",
    reason: "AWS credentials — credential directory blocked by default policy",
  },
  {
    pattern: "**/.gnupg/**",
    action: "*",
    effect: "deny",
    reason: "GPG keys — credential directory blocked by default policy",
  },
  {
    pattern: "**/.config/gcloud/**",
    action: "*",
    effect: "deny",
    reason: "Google Cloud credentials — credential directory blocked by default policy",
  },
  {
    pattern: "**/.azure/**",
    action: "*",
    effect: "deny",
    reason: "Azure CLI credentials — credential directory blocked by default policy",
  },
  {
    pattern: "**/.kube/**",
    action: "*",
    effect: "deny",
    reason: "Kubernetes configs — credential directory blocked by default policy",
  },
  {
    pattern: "**/.npmrc",
    action: "*",
    effect: "deny",
    reason: "npm auth tokens — credential file blocked by default policy",
  },
  {
    pattern: "**/.pypirc",
    action: "*",
    effect: "deny",
    reason: "PyPI auth tokens — credential file blocked by default policy",
  },
  {
    pattern: "**/.netrc",
    action: "*",
    effect: "deny",
    reason: "Network credentials — credential file blocked by default policy",
  },
  {
    pattern: "**/.vault-token",
    action: "*",
    effect: "deny",
    reason: "HashiCorp Vault token — credential file blocked by default policy",
  },
  {
    pattern: "**/.env",
    action: "*",
    effect: "deny",
    reason: "Environment file (may contain secrets) — blocked by default policy",
  },
  {
    pattern: "**/.env.*",
    action: "*",
    effect: "deny",
    reason: "Environment variant file (may contain secrets) — blocked by default policy",
  },
] as const;

/**
 * Create sourced credential deny rules stamped with the given source.
 * Use `"policy"` for highest precedence (cannot be overridden by user/project rules).
 */
export function createCredentialDenyRules(source: RuleSource): readonly SourcedRule[] {
  return CREDENTIAL_DENY_RULES.map((rule) => ({ ...rule, source }));
}
