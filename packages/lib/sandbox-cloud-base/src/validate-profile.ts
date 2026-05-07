import type { SandboxProfile } from "@koi/core";

export interface UnsupportedProfileFields {
  readonly fields: readonly string[];
}

export function detectUnsupportedProfileFields(
  _profile: SandboxProfile,
): UnsupportedProfileFields | undefined {
  return undefined;
}

export function formatUnsupportedProfileError(unsupported: UnsupportedProfileFields): string {
  if (unsupported.fields.length === 0) {
    return "Unsupported sandbox profile fields";
  }
  return `Unsupported sandbox profile fields: ${unsupported.fields.join(", ")}`;
}
