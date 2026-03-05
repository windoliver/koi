/**
 * Preset sandbox profile constructors.
 */

import type { ToolPolicy } from "@koi/core";
import type { SandboxProfile } from "./types.js";

const SENSITIVE_PATHS: readonly string[] = [
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.config/gcloud",
  "~/.azure",
];

const SENSITIVE_PATTERNS: readonly string[] = [".env", ".env.*"];

const RESTRICTIVE_DEFAULTS: SandboxProfile = {
  filesystem: {
    allowRead: ["/usr", "/bin", "/lib", "/etc", "/tmp"],
    denyRead: [...SENSITIVE_PATHS, ...SENSITIVE_PATTERNS],
    allowWrite: ["/tmp/koi-sandbox-*"],
  },
  network: { allow: false },
  resources: {
    maxMemoryMb: 512,
    timeoutMs: 30_000,
    maxPids: 64,
    maxOpenFiles: 256,
  },
};

const PERMISSIVE_DEFAULTS: SandboxProfile = {
  filesystem: {
    allowRead: ["/usr", "/bin", "/lib", "/etc", "/tmp", "."],
    denyRead: [...SENSITIVE_PATHS],
    allowWrite: ["/tmp", "."],
  },
  network: { allow: true },
  resources: {
    maxMemoryMb: 2048,
    timeoutMs: 120_000,
    maxPids: 256,
    maxOpenFiles: 1024,
  },
};

const PASSTHROUGH_DEFAULTS: SandboxProfile = {
  filesystem: {},
  network: { allow: true },
  resources: {},
};

export function restrictiveProfile(overrides?: Partial<SandboxProfile>): SandboxProfile {
  return mergeProfile(RESTRICTIVE_DEFAULTS, overrides);
}

export function permissiveProfile(overrides?: Partial<SandboxProfile>): SandboxProfile {
  return mergeProfile(PERMISSIVE_DEFAULTS, overrides);
}

/**
 * Creates a SandboxProfile based on the ToolPolicy.
 * Sandboxed tools get restrictive defaults; unsandboxed get passthrough.
 */
export function createProfileFromPolicy(policy: ToolPolicy): SandboxProfile {
  if (policy.sandbox) {
    return restrictiveProfile();
  }
  return { ...PASSTHROUGH_DEFAULTS };
}

/** @deprecated Use createProfileFromPolicy instead. */
export const profileForTier: (policy: ToolPolicy) => SandboxProfile = createProfileFromPolicy;

function mergeProfile(base: SandboxProfile, overrides?: Partial<SandboxProfile>): SandboxProfile {
  if (overrides === undefined) {
    return { ...base };
  }
  const result: SandboxProfile = {
    filesystem: overrides.filesystem ?? base.filesystem,
    network: overrides.network ?? base.network,
    resources: overrides.resources ?? base.resources,
  };
  const env = overrides.env ?? base.env;
  if (env !== undefined) {
    return { ...result, env };
  }
  return result;
}
