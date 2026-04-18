/**
 * Skill file loader — parse + validate + security scan + cache.
 *
 * Applied decisions:
 * - 2A: instance-scoped cache (Map inside factory closure, not module-level)
 * - 3A: fail-closed security — blocks on >= blockOnSeverity via PERMISSION error
 * - 5A: buildSkillDefinition() helper to DRY optional-field spreading
 * - 7A: makeFindingCallback() helper to DRY the finding callback adapter
 * - 7B (new): blockOnSeverity typed as Severity — no 'as' casts needed
 * - 13A: instance-scoped scanner passed in (no module-level scanner)
 * - 15A: skillsRoot pre-resolved once at discovery time (Decision 6A in discover.ts),
 *         passed via LoaderContext — no per-load realpath
 * - 16A: MAX_BUNDLED_FILES and MAX_BUNDLED_FILE_SIZE_BYTES guards
 */

import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { KoiError, Result } from "@koi/core";
import type { ScanFinding, Scanner } from "@koi/skill-scanner";
import { type Severity, severityAtOrAbove } from "@koi/validation";
import type { BodyCache } from "./lru-cache.js";
import { mapFrontmatterToDefinition } from "./map-frontmatter.js";
import type { ParsedSkillMd } from "./parse.js";
import { parseSkillMd } from "./parse.js";
import type { ResolvedInclude } from "./resolve-includes.js";
import { resolveIncludes } from "./resolve-includes.js";
import type { SkillDefinition, SkillSource } from "./types.js";
import { validateFrontmatter } from "./validate.js";

// ---------------------------------------------------------------------------
// Constants (Decision 16A)
// ---------------------------------------------------------------------------

export const MAX_BUNDLED_FILES: number = 50;
export const MAX_BUNDLED_FILE_SIZE_BYTES: number = 512 * 1024; // 512 KB

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Decision 7A: DRY the finding callback adapter.
 * Returns a function that routes findings to the user's onSecurityFinding
 * callback, splitting above/below the block threshold.
 * Decision 7B: blockOnSeverity typed as Severity — no 'as' casts needed.
 */
function makeFindingCallback(
  name: string,
  blockOnSeverity: Severity,
  onSecurityFinding?: (name: string, findings: readonly ScanFinding[]) => void,
): (findings: readonly ScanFinding[]) => { readonly blocked: boolean } {
  return (findings) => {
    if (findings.length === 0) return { blocked: false };

    const blocking = findings.filter((f: ScanFinding) =>
      severityAtOrAbove(f.severity, blockOnSeverity),
    );
    const nonBlocking = findings.filter(
      (f: ScanFinding) => !severityAtOrAbove(f.severity, blockOnSeverity),
    );

    if (nonBlocking.length > 0) {
      onSecurityFinding?.(name, nonBlocking);
    }

    return { blocked: blocking.length > 0 };
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoaderContext {
  /**
   * Instance-scoped skill cache. Bounded LRU when `cacheMaxBodies` is finite;
   * otherwise unbounded (legacy behavior). Drives `onSkillLoaded` via cacheHit
   * detection inside loadSkill().
   */
  readonly cache: BodyCache<Result<SkillDefinition, KoiError>>;
  /** Instance-scoped scanner (Decision 13A). */
  readonly scanner: Scanner;
  /**
   * Pre-resolved absolute skills root for security boundary.
   * Now pre-resolved at discovery time (Decision 6A via discover.ts).
   */
  readonly skillsRoot: string;
  readonly config: {
    readonly blockOnSeverity: Severity;
    readonly onSecurityFinding?: (name: string, findings: readonly ScanFinding[]) => void;
    readonly onShadowedSkill?: (name: string, shadowedBy: SkillSource) => void;
  };
  /**
   * Telemetry hook fired on every resolved load — issue #1642.
   * `cacheHit` is true when the body came from the LRU cache, false when a
   * fresh read + scan + cache-insert just occurred.
   */
  readonly onLoad?: (
    name: string,
    result: Result<SkillDefinition, KoiError>,
    cacheHit: boolean,
  ) => void;
  /**
   * Epoch guard against stale cache writes (review #1896 round 11). Called
   * right before the cache insert completes; if it returns `false` the
   * loader MUST NOT write to the cache. Used by the runtime to suppress
   * results from load() calls whose async work finished after a
   * concurrent `invalidate()` or `registerExternal()` reset the cache.
   */
  readonly shouldCommit?: () => boolean;
}

// ---------------------------------------------------------------------------
// File count + size guards (Decision 16A)
// ---------------------------------------------------------------------------

async function checkFileLimits(
  dirPath: string,
  source: SkillSource,
): Promise<Result<void, KoiError>> {
  if (source !== "bundled") return { ok: true, value: undefined };

  // Only enforce limits for bundled skills
  const glob = new Bun.Glob("**/*");
  // let: count accumulates across async iteration
  let count = 0;

  try {
    for await (const entry of glob.scan({ cwd: dirPath, dot: false })) {
      count += 1;
      if (count > MAX_BUNDLED_FILES) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Bundled skill directory exceeds file limit (${MAX_BUNDLED_FILES}): ${dirPath}`,
            retryable: false,
            context: { errorKind: "BUNDLED_FILE_LIMIT", dirPath, limit: MAX_BUNDLED_FILES },
          },
        };
      }

      const filePath = join(dirPath, entry);
      const file = Bun.file(filePath);
      const size = file.size;
      if (size > MAX_BUNDLED_FILE_SIZE_BYTES) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Bundled skill file exceeds size limit (${MAX_BUNDLED_FILE_SIZE_BYTES} bytes): ${filePath}`,
            retryable: false,
            context: {
              errorKind: "BUNDLED_FILE_SIZE_LIMIT",
              filePath,
              size,
              limit: MAX_BUNDLED_FILE_SIZE_BYTES,
            },
          },
        };
      }
    }
  } catch (cause: unknown) {
    // If we can't enumerate files, don't block loading
    void cause;
  }

  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Core load function
// ---------------------------------------------------------------------------

/**
 * Loads a single skill by name from the discovered source tier.
 *
 * Steps:
 * 1. Check instance cache (Decision 2A)
 * 2. Check file limits (Decision 16A, bundled only)
 * 3. Read and parse SKILL.md
 * 4. Validate frontmatter with Zod (Decision 8A transform in validate.ts)
 * 5. Resolve includes (sequential, Decision 14C)
 * 6. Security scan (Decision 3A: fail-closed on >= blockOnSeverity)
 * 7. Cache and return
 */
export async function loadSkill(
  name: string,
  dirPath: string,
  source: SkillSource,
  ctx: LoaderContext,
): Promise<Result<SkillDefinition, KoiError>> {
  // 1. Check cache (Decision 2A)
  const cached = ctx.cache.get(name);
  if (cached !== undefined) {
    ctx.onLoad?.(name, cached, true);
    return cached;
  }

  const result = await loadSkillUncached(name, dirPath, source, ctx);

  // Cache both successes and failures (to avoid re-scanning known-bad
  // skills), but only when the runtime epoch has not advanced underneath
  // us (review #1896 round 11). A stale-insert after an invalidate() or
  // registerExternal() would resurrect obsolete data; the shouldCommit
  // guard suppresses that.
  if (ctx.shouldCommit === undefined || ctx.shouldCommit()) {
    ctx.cache.set(name, result);
  }
  ctx.onLoad?.(name, result, false);
  return result;
}

async function loadSkillUncached(
  name: string,
  dirPath: string,
  source: SkillSource,
  ctx: LoaderContext,
): Promise<Result<SkillDefinition, KoiError>> {
  // 2. File limits guard (Decision 16A)
  const limitsCheck = await checkFileLimits(dirPath, source);
  if (!limitsCheck.ok) return limitsCheck;

  // 3. Read and parse SKILL.md
  const skillMdPath = join(dirPath, "SKILL.md");
  let content: string; // let: assigned in try, used after catch

  try {
    content = await Bun.file(skillMdPath).text();
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Skill "${name}" not found: could not read ${skillMdPath}`,
        retryable: false,
        cause,
        context: { name, dirPath, skillMdPath },
      },
    };
  }

  // Path traversal guard: dirPath must be within skillsRoot (Decision 9A)
  // Both paths are realpath-resolved to handle /tmp → /private/tmp symlinks on macOS.
  let realDir: string; // let: assigned in try, used after catch
  let realRoot: string; // let: assigned in try, used after catch
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

  try {
    realRoot = await realpath(ctx.skillsRoot);
  } catch {
    // If root can't be resolved, use as-is
    realRoot = ctx.skillsRoot;
  }

  const relToRoot = relative(realRoot, realDir);
  if (relToRoot.startsWith("..") || relToRoot.startsWith("/")) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Skill "${name}" path escapes skills root: ${realDir} is outside ${realRoot}`,
        retryable: false,
        context: { errorKind: "PATH_TRAVERSAL", name, realDir, skillsRoot: realRoot },
      },
    };
  }

  const parseResult: Result<ParsedSkillMd, KoiError> = parseSkillMd(content, skillMdPath);
  if (!parseResult.ok) return parseResult;

  const { frontmatter, body: rawBody } = parseResult.value;

  // 4. Validate frontmatter (Decision 8A: Zod .transform() normalizes allowed-tools)
  const fmResult = validateFrontmatter(frontmatter, skillMdPath);
  if (!fmResult.ok) return fmResult;
  const fm = fmResult.value;

  // 5. Resolve includes (sequential, Decision 14C)
  const rawIncludes = frontmatter.includes;
  // let: body may be extended with include content
  let body = rawBody;
  if (Array.isArray(rawIncludes) && rawIncludes.length > 0) {
    const includes = rawIncludes.filter((i: unknown): i is string => typeof i === "string");
    const includeResult = await resolveIncludes(includes, dirPath, ctx.skillsRoot);
    if (!includeResult.ok) return includeResult;

    // Append resolved include content to body
    const appendix = includeResult.value.map((inc: ResolvedInclude) => inc.content).join("\n\n");
    body = appendix.length > 0 ? `${rawBody}\n\n${appendix}` : rawBody;
  }

  // 6. Security scan (Decision 3A: fail-closed)
  const scanReport = ctx.scanner.scanSkill(`---\n${JSON.stringify(fm)}\n---\n\n${body}`);
  const handleFindings = makeFindingCallback(
    name,
    ctx.config.blockOnSeverity,
    ctx.config.onSecurityFinding,
  );
  const { blocked } = handleFindings(scanReport.findings);

  if (blocked) {
    const blockingFindings = scanReport.findings.filter((f: ScanFinding) =>
      severityAtOrAbove(f.severity, ctx.config.blockOnSeverity),
    );
    const summary = blockingFindings
      .map((f: ScanFinding) => `[${f.severity}] ${f.rule}: ${f.message}`)
      .join("; ");
    return {
      ok: false,
      error: {
        code: "PERMISSION",
        message: `Skill "${name}" blocked by security scan (${blockingFindings.length} finding(s) at or above ${ctx.config.blockOnSeverity}): ${summary}`,
        retryable: false,
        context: {
          name,
          blockOnSeverity: ctx.config.blockOnSeverity,
          findings: blockingFindings,
        },
      },
    };
  }

  // 7. Build and return
  return { ok: true, value: mapFrontmatterToDefinition(fm, body, source, realDir) };
}
