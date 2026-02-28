/**
 * ComponentProvider for filesystem-based Agent Skills with progressive loading.
 *
 * Initial attach loads all skills at "metadata" level (cheapest). Skills can then
 * be promoted to higher levels ("body", "bundled") on demand via promote().
 *
 * Uses parallel loading via Promise.allSettled for initial attach, and fires
 * ComponentEvent notifications on promote() for downstream consumers.
 */

import { resolve } from "node:path";
import type {
  Agent,
  AgentId,
  AttachResult,
  ComponentEvent,
  KoiError,
  Result,
  SkillComponent,
  SkillConfig,
  SkippedComponent,
} from "@koi/core";
import { agentId, COMPONENT_PRIORITY, skillToken } from "@koi/core";
import type { ScanFinding } from "@koi/skill-scanner";
import { loadSkill, resolveSecurePath } from "./loader.js";
import type {
  ProgressiveSkillProvider,
  SkillBundledEntry,
  SkillEntry,
  SkillLoadLevel,
} from "./types.js";
import { isAtOrAbove } from "./types.js";

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
// SkillComponent builder
// ---------------------------------------------------------------------------

/** Builds a SkillComponent from a SkillEntry at any load level. */
function buildSkillComponent(entry: SkillEntry): SkillComponent {
  // let: assigned in exactly one branch of the discriminated union
  let content: string;
  if (entry.level === "metadata") {
    content = entry.description;
  } else if (entry.level === "bundled") {
    content = assembleBundledContent(entry);
  } else {
    content = entry.body;
  }

  return {
    name: entry.name,
    description: entry.description,
    content,
    ...(entry.allowedTools !== undefined ? { tags: [...entry.allowedTools] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SkillProviderConfig {
  /** Skill entries from AgentManifest.skills. */
  readonly skills: readonly SkillConfig[];
  /** Base path for resolving relative skill paths (typically the manifest directory). */
  readonly basePath: string;
  /** Target level for promote() when no explicit level is given. Default: "body". */
  readonly loadLevel?: SkillLoadLevel;
  /** Called when security scanner finds issues in a skill. Receives skill name and findings. */
  readonly onSecurityFinding?: (name: string, findings: readonly ScanFinding[]) => void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingSkill {
  readonly skillConfig: SkillConfig;
  readonly securePath: string;
}

interface LoadOutcome {
  readonly skillConfig: SkillConfig;
  readonly securePath: string;
  readonly result: Result<SkillEntry, KoiError>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a ProgressiveSkillProvider that loads filesystem skills from SKILL.md files.
 *
 * - Priority: BUNDLED (100) — forge skills (0-50) win on name collision
 * - Initial load: "metadata" level for all skills (cheapest)
 * - On-demand promotion via promote() to "body" or "bundled"
 * - Parallel loading via Promise.allSettled
 * - Partial success: failed loads go to `skipped`, rest succeed
 * - First-wins on duplicate skill names
 */
export function createSkillComponentProvider(
  config: SkillProviderConfig,
): ProgressiveSkillProvider {
  const { skills, basePath, loadLevel = "body", onSecurityFinding } = config;

  // Internal mutable state
  // let: cached/components/attachedAgentId are set once during first attach()
  let cached: AttachResult | undefined;
  let components: Map<string, unknown> | undefined;
  let attachedAgentId: AgentId = agentId("unknown");

  const levels = new Map<string, SkillLoadLevel>();
  const resolvedPaths = new Map<string, string>();
  const listeners = new Set<(event: ComponentEvent) => void>();

  // -------------------------------------------------------------------
  // attach — parallel load at "metadata" level
  // -------------------------------------------------------------------

  const attach = async (agent: Agent): Promise<AttachResult> => {
    if (cached !== undefined) return cached;

    // Defensive: extract AgentId from pid.id if available, fallback for minimal stubs
    attachedAgentId = agent.pid?.id ?? agentId("unknown");
    components = new Map<string, unknown>();
    const skipped: SkippedComponent[] = [];
    const seenNames = new Set<string>();

    // Phase 1: resolve paths sequentially (cheap I/O, needs dedup ordering)
    const pending: PendingSkill[] = [];

    for (const skillConfig of skills) {
      if (seenNames.has(skillConfig.name)) {
        skipped.push({
          name: skillConfig.name,
          reason: `Duplicate skill name: "${skillConfig.name}" — first definition wins`,
        });
        continue;
      }
      seenNames.add(skillConfig.name);

      const resolvedDir = resolve(basePath, skillConfig.path);
      const secureResult = await resolveSecurePath(resolvedDir, basePath);
      if (!secureResult.ok) {
        skipped.push({ name: skillConfig.name, reason: secureResult.error.message });
        continue;
      }

      pending.push({ skillConfig, securePath: secureResult.value });
    }

    // Phase 2: load all skills in parallel at "metadata" level
    const settled = await Promise.allSettled(
      pending.map(async (p): Promise<LoadOutcome> => {
        const findingCallback =
          onSecurityFinding !== undefined
            ? (findings: readonly ScanFinding[]) => onSecurityFinding(p.skillConfig.name, findings)
            : undefined;
        const result = await loadSkill(p.securePath, "metadata", findingCallback);
        return { skillConfig: p.skillConfig, securePath: p.securePath, result };
      }),
    );

    // Phase 3: process results in declaration order
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        // Promise.allSettled caught an unexpected throw — skip silently
        continue;
      }

      const { skillConfig, securePath, result: loadResult } = outcome.value;
      if (!loadResult.ok) {
        skipped.push({ name: skillConfig.name, reason: loadResult.error.message });
        continue;
      }

      const entry = loadResult.value;
      const component = buildSkillComponent(entry);
      const tokenKey: string = skillToken(entry.name);
      components.set(tokenKey, component);
      levels.set(entry.name, "metadata");
      resolvedPaths.set(entry.name, securePath);
    }

    cached = { components, skipped };
    return cached;
  };

  // -------------------------------------------------------------------
  // promote — on-demand level escalation
  // -------------------------------------------------------------------

  const promote = async (
    name: string,
    targetLevel?: SkillLoadLevel,
  ): Promise<Result<void, KoiError>> => {
    const target = targetLevel ?? loadLevel;
    const currentLevel = levels.get(name);

    if (currentLevel === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Skill "${name}" not found`,
          retryable: false,
          context: { name },
        },
      };
    }

    // Already at or above target level — no-op
    if (isAtOrAbove(currentLevel, target)) {
      return { ok: true, value: undefined };
    }

    const securePath = resolvedPaths.get(name);
    if (securePath === undefined) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `No resolved path for skill "${name}"`,
          retryable: false,
          context: { name },
        },
      };
    }

    const findingCallback =
      onSecurityFinding !== undefined
        ? (findings: readonly ScanFinding[]) => onSecurityFinding(name, findings)
        : undefined;

    const loadResult = await loadSkill(securePath, target, findingCallback);
    if (!loadResult.ok) {
      return { ok: false, error: loadResult.error };
    }

    const entry = loadResult.value;
    const component = buildSkillComponent(entry);
    const tokenKey: string = skillToken(name);

    if (components !== undefined) {
      components.set(tokenKey, component);
    }
    levels.set(name, target);

    // Notify watch listeners — use "attached" kind (no "updated" in ComponentEventKind)
    const event: ComponentEvent = {
      kind: "attached",
      agentId: attachedAgentId,
      componentKey: tokenKey,
    };
    for (const listener of listeners) {
      listener(event);
    }

    return { ok: true, value: undefined };
  };

  // -------------------------------------------------------------------
  // getLevel — query current level
  // -------------------------------------------------------------------

  const getLevel = (name: string): SkillLoadLevel | undefined => {
    return levels.get(name);
  };

  // -------------------------------------------------------------------
  // watch — ComponentProvider.watch() for event listeners
  // -------------------------------------------------------------------

  const watch = (listener: (event: ComponentEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    name: "@koi/skills",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach,
    watch,
    promote,
    getLevel,
  };
}
