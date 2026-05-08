import type { SandboxProfile } from "@koi/core";

export type { UnsupportedProfileFields } from "@koi/sandbox-cloud-base";
export {
  detectUnsupportedProfileFields,
  formatUnsupportedProfileError,
} from "@koi/sandbox-cloud-base";

/** Profile defaults the adapter *can* honour and forwards to per-call exec. */
export interface ProfileDefaults {
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** Extract supported profile defaults forwarded to per-call exec. */
export function extractProfileDefaults(profile: SandboxProfile): ProfileDefaults {
  return {
    ...(profile.env !== undefined ? { env: profile.env } : {}),
    ...(profile.resources.timeoutMs !== undefined
      ? { timeoutMs: profile.resources.timeoutMs }
      : {}),
  };
}
