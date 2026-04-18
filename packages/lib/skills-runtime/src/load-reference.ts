/**
 * Tier 2 — reference file loading (issue #1642).
 *
 * Reads a file inside a skill's directory on demand. Tier 2 exists so that
 * skill bodies can point the agent at specific helper files (scripts,
 * reference docs, config templates) without injecting every file into context
 * at Tier 1 load time.
 *
 * Security model — mirrors the loader's path-traversal guard (loader.ts)
 * **and** extends it with the same fail-closed policies Tier 1 applies
 * (review #1896 round 1):
 *
 * 1. Path hygiene
 *    - `refPath` must be non-empty and free of null bytes
 *    - `refPath` must not be absolute
 *    - The realpath of the joined path must remain within the realpath of
 *      the skill directory. `..` components or escape-via-symlink are
 *      rejected as VALIDATION / PATH_TRAVERSAL.
 * 2. Size ceiling (`maxBytes`, default 256 KB). Oversized files are rejected
 *    up-front via stat — we never read them. Prevents a reference file
 *    from exhausting context or memory, and bounds latency of retries.
 * 3. Binary guard. If the first 1 KB of the file contains a NUL byte the
 *    content is treated as binary and rejected. Tier 2 is a text-context
 *    channel for the model; binary payloads are out of scope.
 * 4. Security scan. When a `scanner` is provided the content is fed through
 *    the same `scanSkill()` rules that gate Tier 1 (with `blockOnSeverity`).
 *    A blocked reference returns PERMISSION — malicious payloads cannot be
 *    hidden in a `references/` file and smuggled past the Tier 1 gate.
 *
 * Results are **not** cached. Reference fetches are one-shot — the agent
 * requests a file, the runtime reads it, hands back the content. A persistent
 * cache here would be a second source of truth that could diverge from disk
 * and complicate invalidation without saving meaningful I/O.
 */

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";
import type { ScanFinding, Scanner } from "@koi/skill-scanner";
import { type Severity, severityAtOrAbove } from "@koi/validation";

// Null-byte in a path is always adversarial — node itself throws, but catching
// early lets us return a structured VALIDATION error rather than an opaque
// internal failure.
// biome-ignore lint/suspicious/noControlCharactersInRegex: null byte is the intended literal
const NULL_BYTE = /\u0000/;

/**
 * Default reference-file size ceiling. 256 KB is well above any prose
 * reference or reasonable script, and well below the point where loading the
 * file into a single model turn would noticeably squeeze the context window.
 */
export const DEFAULT_MAX_REFERENCE_BYTES: number = 256 * 1024;

/** Number of leading bytes inspected for NUL to classify a file as binary. */
const BINARY_SNIFF_BYTES = 1024;

export interface LoadReferenceOptions {
  /** Upper bound on file size. Files larger than this return VALIDATION without being read. */
  readonly maxBytes?: number;
  /** If provided, the content is scanned with `scanSkill()`. */
  readonly scanner?: Scanner;
  /** Severity threshold. Defaults to "HIGH" when a scanner is supplied. */
  readonly blockOnSeverity?: Severity;
  /** Sub-threshold findings route here. */
  readonly onSecurityFinding?: (name: string, findings: readonly ScanFinding[]) => void;
}

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
 * @param options - size + scanner policy (see LoadReferenceOptions)
 */
export async function loadReference(
  name: string,
  dirPath: string,
  refPath: string,
  options?: LoadReferenceOptions,
): Promise<Result<string, KoiError>> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_REFERENCE_BYTES;
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

  // Size ceiling — stat first so an oversized payload is never read into memory.
  let size: number;
  try {
    const st = await stat(realTarget);
    size = st.size;
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Could not stat reference "${refPath}" for skill "${name}"`,
        retryable: false,
        cause,
        context: { name, refPath, resolvedPath: realTarget },
      },
    };
  }
  if (size > maxBytes) {
    return validationError(
      name,
      refPath,
      `Reference "${refPath}" for skill "${name}" exceeds size limit (${size} > ${maxBytes} bytes)`,
      "REFERENCE_SIZE_LIMIT",
    );
  }

  let content: string;
  try {
    content = await Bun.file(realTarget).text();
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

  // Binary guard — NUL byte in the leading window means the file is not
  // text, so handing it to the model is at best useless and at worst a
  // data-exfiltration or crash vector.
  const prefix = content.slice(0, BINARY_SNIFF_BYTES);
  if (prefix.includes("\u0000")) {
    return validationError(
      name,
      refPath,
      `Reference "${refPath}" for skill "${name}" appears to be binary`,
      "REFERENCE_BINARY",
    );
  }

  // Security scan — Tier 1 applies the same gate to SKILL.md bodies. A skill
  // with clean frontmatter could otherwise hide dangerous prose in a
  // references/*.md file and surface it through this API, which is exactly
  // the attack Tier 2 must not enable. Fail closed on >= blockOnSeverity.
  const scanner = options?.scanner;
  if (scanner !== undefined) {
    const threshold: Severity = options?.blockOnSeverity ?? "HIGH";
    const report = scanner.scanSkill(content);
    const blocking = report.findings.filter((f) => severityAtOrAbove(f.severity, threshold));
    const subThreshold = report.findings.filter((f) => !severityAtOrAbove(f.severity, threshold));
    if (subThreshold.length > 0) {
      options?.onSecurityFinding?.(name, subThreshold);
    }
    if (blocking.length > 0) {
      const summary = blocking.map((f) => `[${f.severity}] ${f.rule}: ${f.message}`).join("; ");
      return {
        ok: false,
        error: {
          code: "PERMISSION",
          message: `Reference "${refPath}" for skill "${name}" blocked by security scan (${blocking.length} finding(s) at or above ${threshold}): ${summary}`,
          retryable: false,
          context: { name, refPath, blockOnSeverity: threshold, findings: blocking },
        },
      };
    }
  }

  return { ok: true, value: content };
}
