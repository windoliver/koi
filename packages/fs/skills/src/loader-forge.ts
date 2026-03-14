/**
 * Progressive loader for forged skills backed by ForgeStore.
 *
 * Mirrors the filesystem loader's three-level strategy:
 * - metadata: trust artifact fields directly (name, description, tags)
 * - body: parse artifact.content via parseSkillMd() + security scan
 * - bundled: body + map artifact.files to scripts/references
 *
 * Load once from ForgeStore, cache full artifact, expose progressively.
 */

import type { BrickId, ForgeStore, KoiError, Result, SkillArtifact } from "@koi/core";
import type { ScanFinding } from "@koi/skill-scanner";
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
// Cache — keyed by BrickId string value
// ---------------------------------------------------------------------------

const forgeSkillCache = new Map<string, SkillArtifact>();

/** Clears the forge skill cache. Exported for testing. */
export function clearForgeSkillCache(): void {
  forgeSkillCache.clear();
}

// ---------------------------------------------------------------------------
// Internal: load and cache artifact
// ---------------------------------------------------------------------------

async function ensureCached(
  brickId: BrickId,
  store: ForgeStore,
): Promise<Result<SkillArtifact, KoiError>> {
  const cached = forgeSkillCache.get(brickId);
  if (cached !== undefined) {
    return { ok: true, value: cached };
  }

  const loadResult = await store.load(brickId);
  if (!loadResult.ok) {
    return { ok: false, error: loadResult.error };
  }

  const artifact = loadResult.value;
  if (artifact.kind !== "skill") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Brick ${brickId} is kind "${artifact.kind}", expected "skill"`,
        retryable: false,
        context: { brickId, actualKind: artifact.kind },
      },
    };
  }

  forgeSkillCache.set(brickId, artifact);
  return { ok: true, value: artifact };
}

// ---------------------------------------------------------------------------
// Progressive loaders
// ---------------------------------------------------------------------------

/**
 * Load forged skill at metadata level — trust artifact fields directly.
 * No SKILL.md parsing at this level (hybrid approach: artifact metadata is authoritative).
 */
export async function loadForgeSkillMetadata(
  brickId: BrickId,
  store: ForgeStore,
): Promise<Result<SkillMetadataEntry, KoiError>> {
  const cacheResult = await ensureCached(brickId, store);
  if (!cacheResult.ok) return cacheResult;

  const artifact = cacheResult.value;

  return {
    ok: true,
    value: {
      level: "metadata",
      name: artifact.name,
      description: artifact.description,
      dirPath: `forge:${brickId}`,
      ...(artifact.tags.length > 0 ? { allowedTools: artifact.tags } : {}),
      ...(artifact.requires !== undefined
        ? {
            requires: {
              ...(artifact.requires.bins !== undefined ? { bins: artifact.requires.bins } : {}),
              ...(artifact.requires.env !== undefined ? { env: artifact.requires.env } : {}),
              ...(artifact.requires.tools !== undefined ? { tools: artifact.requires.tools } : {}),
              ...(artifact.requires.agents !== undefined
                ? { agents: artifact.requires.agents }
                : {}),
              ...(artifact.requires.packages !== undefined
                ? { packages: artifact.requires.packages }
                : {}),
              ...(artifact.requires.network !== undefined
                ? { network: artifact.requires.network }
                : {}),
              ...(artifact.requires.platform !== undefined
                ? { platform: artifact.requires.platform }
                : {}),
              ...(artifact.requires.credentials !== undefined
                ? { credentials: artifact.requires.credentials }
                : {}),
            },
          }
        : {}),
    },
  };
}

/**
 * Load forged skill at body level — parse artifact.content + security scan.
 * Defense-in-depth: always run security scanner on forge skill content.
 */
export async function loadForgeSkillBody(
  brickId: BrickId,
  store: ForgeStore,
  onSecurityFinding?: (findings: readonly ScanFinding[]) => void,
): Promise<Result<SkillBodyEntry, KoiError>> {
  const cacheResult = await ensureCached(brickId, store);
  if (!cacheResult.ok) return cacheResult;

  const artifact = cacheResult.value;

  if (artifact.content.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Forged skill "${artifact.name}" has empty content`,
        retryable: false,
        context: { brickId, name: artifact.name },
      },
    };
  }

  // Parse content to extract markdown body
  const parseResult = parseSkillMd(artifact.content);
  if (!parseResult.ok) return parseResult;

  const validateResult = validateSkillFrontmatter(parseResult.value.frontmatter);
  if (!validateResult.ok) return validateResult;

  // Security scan — always run on forged skills (defense-in-depth)
  const scanner = createScanner();
  const report = scanner.scanSkill(artifact.content);
  if (report.findings.length > 0 && onSecurityFinding !== undefined) {
    onSecurityFinding(report.findings);
  }

  const fm = validateResult.value;

  return {
    ok: true,
    value: {
      level: "body",
      name: fm.name,
      description: fm.description,
      body: parseResult.value.body,
      dirPath: `forge:${brickId}`,
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
 * Load forged skill at bundled level — body + map artifact.files to scripts/references.
 * Convention: file keys starting with "scripts/" → SkillScript, "references/" → SkillReference.
 */
export async function loadForgeSkillBundled(
  brickId: BrickId,
  store: ForgeStore,
  onSecurityFinding?: (findings: readonly ScanFinding[]) => void,
): Promise<Result<SkillBundledEntry, KoiError>> {
  const bodyResult = await loadForgeSkillBody(brickId, store, onSecurityFinding);
  if (!bodyResult.ok) return bodyResult;

  const cacheResult = await ensureCached(brickId, store);
  if (!cacheResult.ok) return cacheResult;

  const artifact = cacheResult.value;
  const scripts: SkillScript[] = [];
  const references: SkillReference[] = [];

  if (artifact.files !== undefined) {
    for (const [key, content] of Object.entries(artifact.files)) {
      if (key.startsWith("scripts/")) {
        scripts.push({ filename: key.slice("scripts/".length), content });
      } else if (key.startsWith("references/")) {
        references.push({ filename: key.slice("references/".length), content });
      }
    }
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
 * Load a forged skill at the specified level. Dispatches to the appropriate loader.
 */
export async function loadForgeSkill(
  brickId: BrickId,
  store: ForgeStore,
  level: SkillLoadLevel = "body",
  onSecurityFinding?: (findings: readonly ScanFinding[]) => void,
): Promise<Result<SkillEntry, KoiError>> {
  switch (level) {
    case "metadata":
      return loadForgeSkillMetadata(brickId, store);
    case "body":
      return loadForgeSkillBody(brickId, store, onSecurityFinding);
    case "bundled":
      return loadForgeSkillBundled(brickId, store, onSecurityFinding);
  }
}
