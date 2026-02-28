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
import { createScanner } from "@koi/skill-scanner";
import { parseSkillMd } from "./parse.js";
import type {
  SkillBodyEntry,
  SkillBundledEntry,
  SkillEntry,
  SkillLoadLevel,
  SkillMetadataEntry,
  SkillReference,
  SkillScript,
} from "./types.js";
import { validateSkillFrontmatter } from "./validate.js";

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

async function readDirFiles(
  dirPath: string,
): Promise<readonly { readonly filename: string; readonly content: string }[]> {
  const glob = new Bun.Glob("*");
  const entries: { readonly filename: string; readonly content: string }[] = [];

  for await (const filename of glob.scan({ cwd: dirPath, onlyFiles: true })) {
    try {
      const content = await Bun.file(join(dirPath, filename)).text();
      entries.push({ filename, content });
    } catch (cause: unknown) {
      console.warn(
        `[koi:skills] Skipping unreadable file ${filename} in ${dirPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Progressive loaders
// ---------------------------------------------------------------------------

/**
 * Load skill at metadata level — frontmatter only.
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
    },
  };
}

/**
 * Load skill at body level — frontmatter + markdown body + security scan (warn-only).
 */
export async function loadSkillBody(dirPath: string): Promise<Result<SkillBodyEntry, KoiError>> {
  const fileResult = await readSkillMd(dirPath);
  if (!fileResult.ok) return fileResult;

  const parseResult = parseSkillMd(fileResult.value);
  if (!parseResult.ok) return parseResult;

  const validateResult = validateSkillFrontmatter(parseResult.value.frontmatter);
  if (!validateResult.ok) return validateResult;

  // Security scan — warn only, don't block developer-authored skills
  const scanner = createScanner();
  const report = scanner.scanSkill(fileResult.value);
  if (report.findings.length > 0) {
    console.warn(
      `[koi:skills] Security findings in ${dirPath}/SKILL.md: ${report.findings.length} issue(s)`,
    );
  }

  const fm = validateResult.value;
  return {
    ok: true,
    value: {
      level: "body",
      name: fm.name,
      description: fm.description,
      body: parseResult.value.body,
      dirPath,
      ...(fm.license !== undefined ? { license: fm.license } : {}),
      ...(fm.compatibility !== undefined ? { compatibility: fm.compatibility } : {}),
      ...(fm.metadata !== undefined ? { metadata: fm.metadata } : {}),
      ...(fm.allowedTools !== undefined ? { allowedTools: fm.allowedTools } : {}),
    },
  };
}

/**
 * Load skill at bundled level — body + scripts/ + references/ contents.
 */
export async function loadSkillBundled(
  dirPath: string,
): Promise<Result<SkillBundledEntry, KoiError>> {
  const bodyResult = await loadSkillBody(dirPath);
  if (!bodyResult.ok) return bodyResult;

  const scriptsDir = join(dirPath, "scripts");
  const referencesDir = join(dirPath, "references");

  // let: conditionally assigned based on directory existence
  let scripts: readonly SkillScript[] = [];
  let references: readonly SkillReference[] = [];

  if (await exists(scriptsDir)) {
    scripts = await readDirFiles(scriptsDir);
  }

  if (await exists(referencesDir)) {
    references = await readDirFiles(referencesDir);
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
): Promise<Result<SkillEntry, KoiError>> {
  switch (level) {
    case "metadata":
      return loadSkillMetadata(dirPath);
    case "body":
      return loadSkillBody(dirPath);
    case "bundled":
      return loadSkillBundled(dirPath);
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
