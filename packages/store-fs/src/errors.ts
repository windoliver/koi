/**
 * Centralized filesystem error mapper.
 *
 * Maps native filesystem errors (ENOENT, EACCES, etc.)
 * to typed KoiError values using @koi/core error factories.
 */

import type { KoiError } from "@koi/core";
import { internal, notFound, permission } from "@koi/core";

/** Extract the error code from a native filesystem error. */
function getErrCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err) {
    return String((err as { code: unknown }).code);
  }
  return undefined;
}

/** Map a native filesystem error to a typed KoiError. */
export function mapFsError(err: unknown, context: string): KoiError {
  const code = getErrCode(err);

  switch (code) {
    case "ENOENT":
      return notFound(context, `File not found: ${context}`);
    case "EACCES":
    case "EPERM":
      return permission(`Permission denied: ${context}`);
    case "ENOSPC":
      return internal(`Disk full while writing: ${context}`, err);
    case "EISDIR":
      return internal(`Expected file, got directory: ${context}`, err);
    default:
      return internal(`Filesystem error for ${context}: ${code ?? "unknown"}`, err);
  }
}

/** Map a JSON parse error to a typed KoiError. */
export function mapParseError(err: unknown, filePath: string): KoiError {
  return internal(`Corrupted brick file: ${filePath}`, err);
}
