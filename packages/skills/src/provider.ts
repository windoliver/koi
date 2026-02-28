/**
 * ComponentProvider for filesystem-based Agent Skills.
 *
 * Resolves SkillConfig entries from the agent manifest into SkillComponents
 * attached under `skillToken(name)`. Uses lazy loading + caching (ForgeProvider pattern).
 */

import { resolve } from "node:path";
import type {
  Agent,
  AttachResult,
  ComponentProvider,
  SkillComponent,
  SkillConfig,
  SkippedComponent,
} from "@koi/core";
import { COMPONENT_PRIORITY, skillToken } from "@koi/core";
import { loadSkill, resolveSecurePath } from "./loader.js";
import type { SkillBundledEntry, SkillLoadLevel } from "./types.js";

// ---------------------------------------------------------------------------
// Content assembly
// ---------------------------------------------------------------------------

/**
 * Assembles bundled content: body + scripts + references into a single string.
 * Scripts and references are formatted as labeled sections after the body.
 */
function assembleBundledContent(entry: SkillBundledEntry): string {
  const parts = [entry.body];

  if (entry.scripts.length > 0) {
    const scriptSections = entry.scripts
      .map((s) => `### ${s.filename}\n\`\`\`\n${s.content}\n\`\`\``)
      .join("\n\n");
    parts.push(`## Scripts\n\n${scriptSections}`);
  }

  if (entry.references.length > 0) {
    const refSections = entry.references
      .map((r) => `### ${r.filename}\n\n${r.content}`)
      .join("\n\n");
    parts.push(`## References\n\n${refSections}`);
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SkillProviderConfig {
  /** Skill entries from AgentManifest.skills. */
  readonly skills: readonly SkillConfig[];
  /** Base path for resolving relative skill paths (typically the manifest directory). */
  readonly basePath: string;
  /** Progressive loading level. Default: "body". */
  readonly loadLevel?: SkillLoadLevel;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a ComponentProvider that loads filesystem skills from SKILL.md files.
 *
 * - Priority: BUNDLED (100) — forge skills (0-50) win on name collision
 * - Lazy: loads on first attach(), caches result
 * - Partial success: failed loads go to `skipped`, rest succeed
 * - First-wins on duplicate skill names
 */
export function createSkillComponentProvider(config: SkillProviderConfig): ComponentProvider {
  const { skills, basePath, loadLevel = "body" } = config;

  // Cache for lazy loading
  let cached: AttachResult | undefined;

  const attach = async (_agent: Agent): Promise<AttachResult> => {
    if (cached !== undefined) return cached;

    const components = new Map<string, unknown>();
    const skipped: SkippedComponent[] = [];
    const seenNames = new Set<string>();

    for (const skillConfig of skills) {
      // Duplicate name check — first-wins
      if (seenNames.has(skillConfig.name)) {
        skipped.push({
          name: skillConfig.name,
          reason: `Duplicate skill name: "${skillConfig.name}" — first definition wins`,
        });
        continue;
      }

      // Resolve path with security checks
      const resolvedDir = resolve(basePath, skillConfig.path);
      const secureResult = await resolveSecurePath(resolvedDir, basePath);
      if (!secureResult.ok) {
        skipped.push({
          name: skillConfig.name,
          reason: secureResult.error.message,
        });
        continue;
      }

      // Load at configured level
      const loadResult = await loadSkill(secureResult.value, loadLevel);
      if (!loadResult.ok) {
        skipped.push({
          name: skillConfig.name,
          reason: loadResult.error.message,
        });
        continue;
      }

      const entry = loadResult.value;

      // Build SkillComponent — progressive content by level
      // metadata: description only, body: markdown body, bundled: body + scripts + references
      let content: string;
      if (entry.level === "metadata") {
        content = entry.description;
      } else if (entry.level === "bundled") {
        content = assembleBundledContent(entry);
      } else {
        content = entry.body;
      }

      const component: SkillComponent = {
        name: entry.name,
        description: entry.description,
        content,
        ...(entry.allowedTools !== undefined ? { tags: [...entry.allowedTools] } : {}),
      };

      // SubsystemToken<T> extends string — assignable to Map<string, unknown> key
      const tokenKey: string = skillToken(entry.name);
      components.set(tokenKey, component);
      seenNames.add(skillConfig.name);
    }

    cached = { components, skipped };
    return cached;
  };

  return {
    name: "@koi/skills",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach,
  };
}
