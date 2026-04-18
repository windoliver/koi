/**
 * Tier 2 — reference file loading (issue #1642).
 *
 * Reads a file inside a skill's directory on demand. Tier 2 exists so that
 * skill bodies can point the agent at specific helper files (scripts,
 * reference docs, config templates) without injecting every file into context
 * at Tier 1 load time.
 *
 * Security model — mirrors the loader's path-traversal guard (loader.ts):
 * 1. `refPath` must be non-empty and free of null bytes
 * 2. `refPath` must not be absolute
 * 3. The realpath of the joined path must remain within the realpath of the
 *    skill directory. A `..` component or an escape-via-symlink both trip
 *    this check and surface as VALIDATION / PATH_TRAVERSAL.
 *
 * Results are **not** cached. Reference fetches are one-shot — the agent
 * requests a file, the runtime reads it, hands back the content. A persistent
 * cache here would be a second source of truth that could diverge from disk
 * and complicate invalidation without saving meaningful I/O.
 */

import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";

// Null-byte in a path is always adversarial — node itself throws, but catching
// early lets us return a structured VALIDATION error rather than an opaque
// internal failure.
// biome-ignore lint/suspicious/noControlCharactersInRegex: null byte is the intended literal
const NULL_BYTE = /\u0000/;

function validationError(
  name: string,
  refPath: string,
  message: string,
  errorKind: string,
): Result<string, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: false,
      context: { errorKind, name, refPath },
    },
  };
}

/**
 * Reads `refPath` relative to the skill directory `dirPath`.
 *
 * @param name - skill name, used only for error context
 * @param dirPath - absolute path to the skill directory (as held in SkillMetadata)
 * @param refPath - relative POSIX path inside the skill directory
 */
export async function loadReference(
  name: string,
  dirPath: string,
  refPath: string,
): Promise<Result<string, KoiError>> {
  if (refPath.length === 0) {
    return validationError(
      name,
      refPath,
      `Reference path for skill "${name}" must not be empty`,
      "EMPTY_REF_PATH",
    );
  }

  if (NULL_BYTE.test(refPath)) {
    return validationError(
      name,
      refPath,
      `Reference path for skill "${name}" must not contain null bytes`,
      "INVALID_REF_PATH",
    );
  }

  if (isAbsolute(refPath)) {
    return validationError(
      name,
      refPath,
      `Reference path for skill "${name}" must be relative to the skill directory`,
      "PATH_TRAVERSAL",
    );
  }

  const joined = join(dirPath, refPath);

  // String-level traversal check — runs before realpath() so a `..` escape
  // that points at a non-existent file still surfaces as PATH_TRAVERSAL
  // rather than NOT_FOUND (NOT_FOUND would leak intent: "that path is
  // outside, but try a nearby one").
  const resolvedJoined = resolve(joined);
  const resolvedDir = resolve(dirPath);
  const relStatic = relative(resolvedDir, resolvedJoined);
  if (relStatic.startsWith("..") || isAbsolute(relStatic)) {
    return validationError(
      name,
      refPath,
      `Reference "${refPath}" for skill "${name}" escapes the skill directory`,
      "PATH_TRAVERSAL",
    );
  }

  // Realpath of the skill directory — required so macOS /tmp -> /private/tmp
  // symlinks don't produce a spurious traversal rejection.
  let realDir: string;
  try {
    realDir = await realpath(dirPath);
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Skill "${name}" directory not found: ${dirPath}`,
        retryable: false,
        cause,
        context: { name, dirPath },
      },
    };
  }

  // Realpath of the target. If it does not yet exist, node throws ENOENT —
  // surface that as NOT_FOUND. Any other failure is treated the same way so
  // the caller receives a consistent error shape.
  let realTarget: string;
  try {
    realTarget = await realpath(joined);
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Reference "${refPath}" not found for skill "${name}"`,
        retryable: false,
        cause,
        context: { name, refPath, resolvedPath: joined },
      },
    };
  }

  const rel = relative(realDir, realTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return validationError(
      name,
      refPath,
      `Reference "${refPath}" for skill "${name}" escapes the skill directory`,
      "PATH_TRAVERSAL",
    );
  }

  try {
    const content = await Bun.file(realTarget).text();
    return { ok: true, value: content };
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Could not read reference "${refPath}" for skill "${name}"`,
        retryable: false,
        cause,
        context: { name, refPath, resolvedPath: realTarget },
      },
    };
  }
}
