import type { KoiError } from "@koi/core";

export const HEADLESS_EXIT = {
  SUCCESS: 0,
  AGENT_FAILURE: 1,
  PERMISSION_DENIED: 2,
  BUDGET_EXCEEDED: 3,
  TIMEOUT: 4,
  INTERNAL: 5,
} as const;

export type HeadlessExitCode = (typeof HEADLESS_EXIT)[keyof typeof HEADLESS_EXIT];

function isKoiError(e: unknown): e is KoiError {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof (e as { readonly code: unknown }).code === "string" &&
    "message" in e
  );
}

export function mapErrorToExitCode(err: unknown): HeadlessExitCode {
  if (err === undefined) return HEADLESS_EXIT.SUCCESS;
  if (!isKoiError(err)) return HEADLESS_EXIT.INTERNAL;
  switch (err.code) {
    case "PERMISSION":
      return HEADLESS_EXIT.PERMISSION_DENIED;
    case "TIMEOUT":
      return HEADLESS_EXIT.TIMEOUT;
    case "INTERNAL":
      return HEADLESS_EXIT.INTERNAL;
    default:
      return HEADLESS_EXIT.AGENT_FAILURE;
  }
}
