import type { JsonObject, KoiError } from "@koi/core";

type ExtensionErrorCode =
  | "EXT_NOT_INSTALLED"
  | "EXT_WRONG_VERSION"
  | "EXT_USER_DENIED"
  | "TRANSPORT_LOST"
  | "HOST_SPAWN_FAILED"
  | "HOST_AMBIGUOUS"
  | "REATTACH_REQUIRES_CONSENT"
  | "TRANSPORT_LOST_GIVE_UP";

function baseCode(code: ExtensionErrorCode): KoiError["code"] {
  switch (code) {
    case "EXT_NOT_INSTALLED":
    case "EXT_WRONG_VERSION":
    case "HOST_SPAWN_FAILED":
      return "UNAVAILABLE";
    case "EXT_USER_DENIED":
    case "REATTACH_REQUIRES_CONSENT":
      return "PERMISSION";
    case "TRANSPORT_LOST":
      return "EXTERNAL";
    case "HOST_AMBIGUOUS":
      return "CONFLICT";
    case "TRANSPORT_LOST_GIVE_UP":
      return "INTERNAL";
  }
}

function retryable(code: ExtensionErrorCode): boolean {
  switch (code) {
    case "TRANSPORT_LOST":
      return true;
    default:
      return false;
  }
}

export function createExtensionError(
  code: ExtensionErrorCode,
  message: string,
  context?: JsonObject,
  cause?: unknown,
): KoiError {
  const error: KoiError = {
    code: baseCode(code),
    message,
    retryable: retryable(code),
    context: {
      extensionCode: code,
      ...(context ?? {}),
    },
  };
  if (cause !== undefined) {
    return { ...error, cause };
  }
  return error;
}

export function translateSessionEnded(reason: string, sessionId: string): KoiError {
  switch (reason) {
    case "private_origin":
      return createExtensionError(
        "EXT_USER_DENIED",
        "Browser extension ended the session due to private-origin policy.",
        {
          reason,
          sessionId,
        },
      );
    default:
      return {
        code: "STALE_REF",
        message: `Session "${sessionId}" ended in the browser extension (${reason}). Re-snapshot after reconnect.`,
        retryable: false,
        context: { refId: sessionId, reason },
      };
  }
}
