/**
 * Preset sandbox profile constructors.
 */

import type { SandboxProfile, TrustTier } from "@koi/core";

const SENSITIVE_PATHS: readonly string[] = [
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.config/gcloud",
  "~/.azure",
];

const SENSITIVE_PATTERNS: readonly string[] = [".env", ".env.*"];

const RESTRICTIVE_DEFAULTS: SandboxProfile = {
  tier: "sandbox",
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
  tier: "verified",
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
  tier: "promoted",
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

export function profileForTier(tier: TrustTier): SandboxProfile {
  switch (tier) {
    case "sandbox":
      return restrictiveProfile();
    case "verified":
      return permissiveProfile();
    case "promoted":
      return { ...PASSTHROUGH_DEFAULTS };
  }
}

function mergeProfile(base: SandboxProfile, overrides?: Partial<SandboxProfile>): SandboxProfile {
  if (overrides === undefined) {
    return { ...base };
  }
  const result: SandboxProfile = {
    tier: overrides.tier ?? base.tier,
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
