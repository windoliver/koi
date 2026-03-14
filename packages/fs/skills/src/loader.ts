/**
 * Progressive filesystem loader for Agent Skills Standard.
 *
 * Three loading levels:
 * - metadata: frontmatter only (cheapest)
 * - body: frontmatter + markdown body + security scan
 * - bundled: body + scripts/ + references/ directory contents
 */

import { exists, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";
import type { ScanFinding } from "@koi/skill-scanner";
import { createScanner } from "@koi/skill-scanner";
import { parseSkillMd } from "./parse.js";
import { resolveIncludes } from "./resolve-includes.js";
import type {
  IncludeResolutionOptions,
  SkillBodyEntry,
  SkillBundledEntry,
  SkillEntry,
  SkillLoadLevel,
  SkillMetadataEntry,
  SkillReference,
  SkillScript,
} from "./types.js";
import type { ValidatedSkillFrontmatter } from "./validate.js";
import { validateSkillFrontmatter } from "./validate.js";

// ---------------------------------------------------------------------------
// Frontmatter cache — avoids re-parsing SKILL.md when escalating load levels
// ---------------------------------------------------------------------------

interface CachedSkillParse {
  readonly frontmatter: ValidatedSkillFrontmatter;
  readonly body: string;
  readonly rawContent: string;
}

const skillCache = new Map<string, CachedSkillParse>();

/**
 * Clears the internal frontmatter cache. Exported for testing only.
 */
export function clearSkillCache(): void {
  skillCache.clear();
}

/**
 * Clears a single cache entry by directory path.
 * Used by hot-mount to force a fresh load after file changes.
 */
export function clearSkillCacheEntry(dirPath: string): void {
  skillCache.delete(dirPath);
}

// ---------------------------------------------------------------------------
// Security: path traversal protection
// ---------------------------------------------------------------------------

/**
 * Resolves a directory path and validates it stays within the expected base.
 * Defense-in-depth: resolve → realpath (follows symlinks) → prefix check.
 */
async function resolveSecurePath(
  dirPath: string,
  basePath?: string,
): Promise<Result<string, KoiError>> {
  const resolved = resolve(dirPath);

  let real: string;
  try {
    real = await realpath(resolved);
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Skill directory not found: ${resolved}`,
        retryable: false,
        cause,
        context: { dirPath },
      },
    };
  }

  if (basePath !== undefined) {
    let realBase: string;
    try {
      realBase = await realpath(resolve(basePath));
    } catch (cause: unknown) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Skill base directory not found: ${basePath}`,
          retryable: false,
          cause,
          context: { basePath },
        },
      };
    }
    if (!real.startsWith(`${realBase}/`) && real !== realBase) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Skill path escapes base directory: ${dirPath} resolves to ${real}`,
          retryable: false,
          context: { dirPath, basePath, resolvedPath: real },
        },
      };
    }
  }

  return { ok: true, value: real };
}

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

async function readSkillMd(dirPath: string): Promise<Result<string, KoiError>> {
  const skillMdPath = join(dirPath, "SKILL.md");
  try {
    const content = await Bun.file(skillMdPath).text();
    return { ok: true, value: content };
  } catch (cause: unknown) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `SKILL.md not found in ${dirPath}`,
        retryable: false,
        cause,
        context: { dirPath, path: skillMdPath },
      },
    };
  }
}

async function readDirFiles(dirPath: string): Promise<{
  readonly files: readonly { readonly filename: string; readonly content: string }[];
  readonly skipped: readonly string[];
}> {
  const glob = new Bun.Glob("*");
  const files: { readonly filename: string; readonly content: string }[] = [];
  const skipped: string[] = [];

  for await (const filename of glob.scan({ cwd: dirPath, onlyFiles: true })) {
    try {
      const content = await Bun.file(join(dirPath, filename)).text();
      files.push({ filename, content });
    } catch (_cause: unknown) {
      skipped.push(filename);
    }
  }

  return { files, skipped };
}

// ---------------------------------------------------------------------------
// Progressive loaders
// ---------------------------------------------------------------------------

/**
 * Load skill at metadata level — frontmatter only.
 * Populates the internal cache so subsequent body/bundled loads skip re-parsing.
 */
export async function loadSkillMetadata(
  dirPath: string,
): Promise<Result<SkillMetadataEntry, KoiError>> {
  const fileResult = await readSkillMd(dirPath);
  if (!fileResult.ok) return fileResult;

  const parseResult = parseSkillMd(fileResult.value);
  if (!parseResult.ok) return parseResult;

  const validateResult = validateSkillFrontmatter(parseResult.value.frontmatter);
  if (!validateResult.ok) return validateResult;

  const fm = validateResult.value;

  // Populate cache for subsequent body/bundled loads
  skillCache.set(dirPath, {
    frontmatter: fm,
    body: parseResult.value.body,
    rawContent: fileResult.value,
  });

  return {
    ok: true,
    value: {
      level: "metadata",
      name: fm.name,
      description: fm.description,
      dirPath,
      ...(fm.license !== undefined ? { license: fm.license } : {}),
      ...(fm.compatibility !== undefined ? { compatibility: fm.compatibility } : {}),
      ...(fm.metadata !== undefined ? { metadata: fm.metadata } : {}),
      ...(fm.allowedTools !== undefined ? { allowedTools: fm.allowedTools } : {}),
      ...(fm.requires !== undefined ? { requires: fm.requires } : {}),
      ...(fm.configSchema !== undefined ? { configSchema: fm.configSchema } : {}),
    },
  };
}

/**
 * Load skill at body level — frontmatter + markdown body + security scan.
 * Uses cached parse results when available (populated by loadSkillMetadata).
 *
 * When `skillsRoot` is provided and the frontmatter contains `includes`,
 * the included file contents are appended to the body.
 */
export async function loadSkillBody(
  dirPath: string,
  onSecurityFinding?: (findings: readonly ScanFinding[]) => void,
  skillsRoot?: string,
): Promise<Result<SkillBodyEntry, KoiError>> {
  // Check cache first — reuse frontmatter and rawContent from prior metadata load
  const cached = skillCache.get(dirPath);

  let fm: ValidatedSkillFrontmatter;
  let body: string;
  let rawContent: string;

  if (cached !== undefined) {
    fm = cached.frontmatter;
    body = cached.body;
    rawContent = cached.rawContent;
  } else {
    const fileResult = await readSkillMd(dirPath);
    if (!fileResult.ok) return fileResult;

    const parseResult = parseSkillMd(fileResult.value);
    if (!parseResult.ok) return parseResult;

    const validateResult = validateSkillFrontmatter(parseResult.value.frontmatter);
    if (!validateResult.ok) return validateResult;

    fm = validateResult.value;
    body = parseResult.value.body;
    rawContent = fileResult.value;

    // Populate cache for potential bundled escalation
    skillCache.set(dirPath, { frontmatter: fm, body, rawContent });
  }

  // Security scan — report findings via callback, don't block developer-authored skills
  const scanner = createScanner();
  const report = scanner.scanSkill(rawContent);
  if (report.findings.length > 0 && onSecurityFinding !== undefined) {
    onSecurityFinding(report.findings);
  }

  // Resolve includes — append included content to body
  let resolvedBody = body; // let: conditionally extended with included content
  if (fm.includes !== undefined && fm.includes.length > 0 && skillsRoot !== undefined) {
    const includeOptions: IncludeResolutionOptions = { skillsRoot };
    const includesResult = await resolveIncludes(fm.includes, dirPath, includeOptions);
    if (!includesResult.ok) return includesResult;

    const includedContent = includesResult.value.map((inc) => inc.content).join("\n\n");
    resolvedBody = `${body}\n\n${includedContent}`;
  }

  return {
    ok: true,
    value: {
      level: "body",
      name: fm.name,
      description: fm.description,
      body: resolvedBody,
      dirPath,
      ...(fm.license !== undefined ? { license: fm.license } : {}),
      ...(fm.compatibility !== undefined ? { compatibility: fm.compatibility } : {}),
      ...(fm.metadata !== undefined ? { metadata: fm.metadata } : {}),
      ...(fm.allowedTools !== undefined ? { allowedTools: fm.allowedTools } : {}),
      ...(fm.requires !== undefined ? { requires: fm.requires } : {}),
      ...(fm.configSchema !== undefined ? { configSchema: fm.configSchema } : {}),
    },
  };
}

/**
 * Load skill at bundled level — body + scripts/ + references/ contents.
 */
export async function loadSkillBundled(
  dirPath: string,
  onSecurityFinding?: (findings: readonly ScanFinding[]) => void,
  skillsRoot?: string,
): Promise<Result<SkillBundledEntry, KoiError>> {
  const bodyResult = await loadSkillBody(dirPath, onSecurityFinding, skillsRoot);
  if (!bodyResult.ok) return bodyResult;

  const scriptsDir = join(dirPath, "scripts");
  const referencesDir = join(dirPath, "references");

  // let: conditionally assigned based on directory existence
  let scripts: readonly SkillScript[] = [];
  let references: readonly SkillReference[] = [];

  if (await exists(scriptsDir)) {
    const result = await readDirFiles(scriptsDir);
    scripts = result.files;
  }

  if (await exists(referencesDir)) {
    const result = await readDirFiles(referencesDir);
    references = result.files;
  }

  const { level: _, ...rest } = bodyResult.value;
  return {
    ok: true,
    value: {
      ...rest,
      level: "bundled",
      scripts,
      references,
    },
  };
}

/**
 * Load a skill at the specified level. Dispatches to the appropriate loader.
 */
export async function loadSkill(
  dirPath: string,
  level: SkillLoadLevel = "body",
  onSecurityFinding?: (findings: readonly ScanFinding[]) => void,
  skillsRoot?: string,
): Promise<Result<SkillEntry, KoiError>> {
  switch (level) {
    case "metadata":
      return loadSkillMetadata(dirPath);
    case "body":
      return loadSkillBody(dirPath, onSecurityFinding, skillsRoot);
    case "bundled":
      return loadSkillBundled(dirPath, onSecurityFinding, skillsRoot);
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discovers skill directories under a base path.
 * Scans for subdirectories containing a SKILL.md file.
 */
export async function discoverSkillDirs(
  basePath: string,
): Promise<Result<readonly string[], KoiError>> {
  const secureResult = await resolveSecurePath(basePath);
  if (!secureResult.ok) return secureResult;

  const resolvedBase = secureResult.value;
  const glob = new Bun.Glob("*/SKILL.md");
  const dirs: string[] = [];

  for await (const match of glob.scan({ cwd: resolvedBase, onlyFiles: true })) {
    const dir = join(resolvedBase, dirname(match));
    dirs.push(dir);
  }

  return { ok: true, value: dirs };
}

// Re-export for use by provider
export { resolveSecurePath };
