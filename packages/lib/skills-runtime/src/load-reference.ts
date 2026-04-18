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
 * 2. Size ceiling (`maxBytes`, default 256 KB). The file is opened **once**
 *    with `O_NOFOLLOW` on the final segment, then `fstat` is performed on
 *    the same descriptor and the content is read from that descriptor. This
 *    closes the TOCTOU window where a racing writer could swap a
 *    validated file for an oversized payload or an out-of-tree symlink
 *    between a path-based stat and a path-based read (review #1896 round 2).
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

import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

/**
 * Extensions that the skill-scanner's AST pass can meaningfully parse.
 * Files with these suffixes are routed to `scanner.scan()` so the AST rules
 * run on the whole file, not just fenced code blocks inside Markdown.
 */
const SOURCE_EXTENSIONS = new Set<string>([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/**
 * Extensions that Tier 2 is allowed to surface.
 *
 * Positive allowlist, tightened in review #1896 round 6 to exactly the
 * formats the skill-scanner can meaningfully inspect:
 * - `.md` / `.mdx`: scanSkill() extracts fenced code blocks and runs the
 *   AST rules on each, plus prose text rules across the whole document.
 * - `.ts` / `.tsx` / `.mts` / `.cts` / `.js` / `.jsx` / `.mjs` / `.cjs`:
 *   scanner.scan() AST-parses the whole file.
 *
 * Non-markdown config formats (.json / .yaml / .toml) and raw script
 * languages (.sh / .py / .rb / etc.) are intentionally excluded: the
 * scanner has no whole-file rules for them, and letting them through
 * would let a skill smuggle dangerous content past the security gate.
 * A caller that needs a broader surface must widen the allowlist in
 * tandem with adding proper scanner coverage for the new format.
 */
const ALLOWED_REFERENCE_EXTENSIONS = new Set<string>([
  ".md",
  ".mdx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

function getExtension(refPath: string): string | undefined {
  const lastDot = refPath.lastIndexOf(".");
  if (lastDot < 0) return undefined;
  return refPath.slice(lastDot).toLowerCase();
}

function isSourceExtension(refPath: string): boolean {
  const ext = getExtension(refPath);
  return ext !== undefined && SOURCE_EXTENSIONS.has(ext);
}

function isAllowedExtension(refPath: string): boolean {
  const ext = getExtension(refPath);
  return ext !== undefined && ALLOWED_REFERENCE_EXTENSIONS.has(ext);
}

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

  if (!isAllowedExtension(refPath)) {
    return validationError(
      name,
      refPath,
      `Reference "${refPath}" for skill "${name}" has an unsupported extension — only text and JS/TS source files are allowed`,
      "REFERENCE_UNSUPPORTED_EXTENSION",
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

  // Parent-path boundary check (review #1896 round 3). `O_NOFOLLOW` on open
  // only protects the *final* segment. A skill can still ship a symlink
  // directory component (`refs -> /outside/tree`) and ask for
  // `refs/secret.txt` — without this check we would resolve through the
  // symlink and expose existence/size/type oracles for files outside the
  // skill directory. Realpath the target's parent directory and require it
  // to stay inside the skill's realpath.
  const parentDir = dirname(joined);
  try {
    const realParent = await realpath(parentDir);
    const parentRel = relative(realDir, realParent);
    if (parentRel.startsWith("..") || isAbsolute(parentRel)) {
      return validationError(
        name,
        refPath,
        `Reference "${refPath}" for skill "${name}" traverses a directory that escapes the skill directory`,
        "PATH_TRAVERSAL",
      );
    }
  } catch (cause: unknown) {
    // Missing parent directory is a genuine NOT_FOUND, not a security issue.
    const err = cause as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
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
    // Other failures (EACCES etc.) — fail closed as a traversal rejection so
    // we never open through an unverifiable parent.
    return validationError(
      name,
      refPath,
      `Reference "${refPath}" for skill "${name}" could not be boundary-verified`,
      "PATH_TRAVERSAL",
    );
  }

  // Open the target once, with O_NOFOLLOW on the final segment. All
  // subsequent checks (size, content) run against this same descriptor so a
  // concurrent writer cannot swap files between checks (review #1896 round 2).
  const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(joined, flags);
  } catch (cause: unknown) {
    // ELOOP: the final segment is a symlink — refuse, since Tier 2 must not
    // follow links out of the skill directory.
    const err = cause as NodeJS.ErrnoException;
    if (err?.code === "ELOOP" || err?.code === "EMLINK") {
      return validationError(
        name,
        refPath,
        `Reference "${refPath}" for skill "${name}" is a symlink`,
        "PATH_TRAVERSAL",
      );
    }
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

  let content: string;
  try {
    // fstat on the opened descriptor. The `isFile()` and boundary checks
    // below rely on the inode held open; the earlier `stat.size` is
    // advisory only — the final size ceiling is enforced by the bounded
    // read below (review #1896 round 4).
    const fst = await handle.stat();
    if (!fst.isFile()) {
      return validationError(
        name,
        refPath,
        `Reference "${refPath}" for skill "${name}" is not a regular file`,
        "REFERENCE_NOT_FILE",
      );
    }

    // Realpath-based boundary check uses the in-tree path that the
    // descriptor was opened against. Because we still hold the open fd,
    // the inode the descriptor points at cannot change under us — a swap
    // after this point hits the new inode, not the one we read.
    const realTarget = await realpath(joined);
    const rel = relative(realDir, realTarget);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return validationError(
        name,
        refPath,
        `Reference "${refPath}" for skill "${name}" escapes the skill directory`,
        "PATH_TRAVERSAL",
      );
    }

    // Bounded read — allocate exactly `maxBytes + 1`. If the file grew in
    // place between fstat and read (a racing writer appended) the extra
    // byte surfaces the overflow and we fail closed. `handle.readFile()`
    // offers no byte limit, so we use the low-level `handle.read()` to
    // stop reading at the cap rather than trusting the earlier size.
    const cap = maxBytes + 1;
    const buf = new Uint8Array(cap);
    let bytesRead = 0;
    while (bytesRead < cap) {
      const { bytesRead: chunk } = await handle.read(buf, bytesRead, cap - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    if (bytesRead > maxBytes) {
      return validationError(
        name,
        refPath,
        `Reference "${refPath}" for skill "${name}" exceeds size limit (> ${maxBytes} bytes)`,
        "REFERENCE_SIZE_LIMIT",
      );
    }
    const slice = buf.subarray(0, bytesRead);

    // Binary guard on the leading bytes — runs before scanning so
    // obviously-binary payloads never reach the scanner or the model.
    const sniffEnd = Math.min(slice.length, BINARY_SNIFF_BYTES);
    for (let i = 0; i < sniffEnd; i++) {
      if (slice[i] === 0x00) {
        return validationError(
          name,
          refPath,
          `Reference "${refPath}" for skill "${name}" appears to be binary`,
          "REFERENCE_BINARY",
        );
      }
    }

    content = new TextDecoder("utf-8").decode(slice);
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Could not read reference "${refPath}" for skill "${name}"`,
        retryable: false,
        cause,
        context: { name, refPath, resolvedPath: joined },
      },
    };
  } finally {
    await handle.close().catch(() => {
      // Close-failure is non-fatal — the fd goes away when the process exits.
      // Logging here would leak the refPath to stderr unconditionally.
    });
  }

  // Security scan — Tier 1 applies the same gate to SKILL.md bodies. A skill
  // with clean frontmatter could otherwise hide dangerous prose in a
  // references/*.md file and surface it through this API, which is exactly
  // the attack Tier 2 must not enable. Fail closed on >= blockOnSeverity.
  //
  // Dispatch by extension (review #1896 round 4). `scanSkill()` only runs
  // its AST pass on fenced Markdown code blocks, so a raw `scripts/run.sh`
  // or `tool.ts` with no fences would slip through unscanned. Treat each
  // recognized source extension as a code file and route to `.scan()`,
  // which AST-parses the whole file. Markdown (and unknown extensions)
  // stay on `.scanSkill()` so prose rules still apply.
  const scanner = options?.scanner;
  if (scanner !== undefined) {
    const threshold: Severity = options?.blockOnSeverity ?? "HIGH";
    const report = isSourceExtension(refPath)
      ? scanner.scan(content, refPath)
      : scanner.scanSkill(content);
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
