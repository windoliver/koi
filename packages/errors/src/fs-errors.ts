/**
 * Filesystem error mapper — maps native FS errors to KoiError.
 *
 * Moved from @koi/store-fs to @koi/errors so all L2 packages can
 * use filesystem error mapping without violating peer-import rules.
 */

import type { KoiError, KoiErrorCode } from "@koi/core";
import { internal, notFound, permission, timeout } from "@koi/core";
import { extractCode } from "./error-utils.js";

type KnownFsCode =
  | "ENOENT"
  | "EACCES"
  | "EPERM"
  | "EBUSY"
  | "ENOSPC"
  | "EISDIR"
  | "ENOTDIR"
  | "ELOOP"
  | "EIO";

interface FsMapping {
  readonly code: KoiErrorCode;
  readonly retryable: boolean;
  readonly messagePrefix: string;
}

const FS_CODE_MAP: Readonly<Record<KnownFsCode, FsMapping>> = {
  ENOENT: { code: "NOT_FOUND", retryable: false, messagePrefix: "File not found" },
  EACCES: { code: "PERMISSION", retryable: false, messagePrefix: "Permission denied" },
  EPERM: { code: "PERMISSION", retryable: false, messagePrefix: "Permission denied" },
  EBUSY: { code: "TIMEOUT", retryable: true, messagePrefix: "File busy" },
  ENOSPC: { code: "INTERNAL", retryable: false, messagePrefix: "Disk full while writing" },
  EISDIR: { code: "INTERNAL", retryable: false, messagePrefix: "Expected file, got directory" },
  ENOTDIR: { code: "INTERNAL", retryable: false, messagePrefix: "Expected directory, got file" },
  ELOOP: { code: "INTERNAL", retryable: false, messagePrefix: "Too many symbolic links" },
  EIO: { code: "INTERNAL", retryable: false, messagePrefix: "I/O error" },
};

/** Map a native filesystem error to a typed KoiError. */
export function mapFsError(err: unknown, context: string): KoiError {
  const osCode = extractCode(err) as KnownFsCode | undefined;
  const mapped = osCode !== undefined ? FS_CODE_MAP[osCode] : undefined;

  if (mapped === undefined) {
    return internal(`Filesystem error for ${context}: ${osCode ?? "unknown"}`, err);
  }

  const message = `${mapped.messagePrefix}: ${context}`;

  switch (mapped.code) {
    case "NOT_FOUND":
      return notFound(context, message);
    case "PERMISSION":
      return permission(message);
    case "TIMEOUT":
      return timeout(message);
    default:
      return internal(message, err);
  }
}

/** Map a JSON parse error to a typed KoiError. */
export function mapParseError(err: unknown, filePath: string): KoiError {
  return internal(`Corrupted brick file: ${filePath}`, err);
}
