/**
 * ComponentProvider for Agent Skills with progressive loading.
 *
 * Supports both filesystem (SKILL.md) and forged (ForgeStore) skill sources.
 * Initial attach loads all skills at "metadata" level (cheapest). Skills can then
 * be promoted to higher levels ("body", "bundled") on demand via promote().
 *
 * Uses parallel loading via Promise.allSettled for initial attach, and fires
 * ComponentEvent notifications on promote() for downstream consumers.
 *
 * Single-agent design: the provider caches results from the first attach() and
 * binds ComponentEvents to that agent's ID. Create a separate provider instance
 * per agent if multi-agent use is needed.
 */

import { resolve } from "node:path";
import type {
  Agent,
  AgentId,
  AttachResult,
  BrickId,
  ComponentEvent,
  ForgeStore,
  KoiError,
  Result,
  SkillComponent,
  SkillConfig,
  SkillSource,
  SkippedComponent,
} from "@koi/core";
import { agentId, COMPONENT_PRIORITY, skillToken } from "@koi/core";
import type { ScanFinding } from "@koi/skill-scanner";
import { clearSkillCacheEntry, loadSkill, resolveSecurePath } from "./loader.js";
import { loadForgeSkill } from "./loader-forge.js";
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
    ...(entry.requires !== undefined ? { requires: entry.requires } : {}),
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
  /** ForgeStore instance — required if any skill has source.kind === "forged". */
  readonly store?: ForgeStore;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingFilesystemSkill {
  readonly kind: "filesystem";
  readonly skillConfig: SkillConfig;
  readonly securePath: string;
}

interface PendingForgedSkill {
  readonly kind: "forged";
  readonly skillConfig: SkillConfig;
  readonly brickId: BrickId;
}

type PendingSkill = PendingFilesystemSkill | PendingForgedSkill;

interface LoadOutcome {
  readonly skillConfig: SkillConfig;
  readonly result: Result<SkillEntry, KoiError>;
  /** Present only for filesystem skills. */
  readonly securePath?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a ProgressiveSkillProvider that loads skills from filesystem or ForgeStore.
 *
 * - Priority: BUNDLED (100) — forge skills (0-50) win on name collision
 * - Initial load: "metadata" level for all skills (cheapest)
 * - On-demand promotion via promote() to "body" or "bundled"
 * - Parallel loading via Promise.allSettled
 * - Partial success: failed loads go to `skipped`, rest succeed
 * - First-wins on duplicate skill names
 *
 * @throws Error if forged skills exist but no ForgeStore was provided
 */
export function createSkillComponentProvider(
  config: SkillProviderConfig,
): ProgressiveSkillProvider {
  const { skills, basePath, loadLevel = "body", onSecurityFinding, store } = config;

  // Fail-fast: error at creation if forged skills exist but no ForgeStore
  const hasForgedSkills = skills.some((s) => s.source.kind === "forged");
  if (hasForgedSkills && store === undefined) {
    throw new Error("SkillConfig contains forged skills but no ForgeStore was provided");
  }

  // Narrow store for forged skill paths — throws if missing (should never happen after fail-fast)
  const requireStore = (): ForgeStore => {
    if (store === undefined) {
      throw new Error("ForgeStore is required for forged skills");
    }
    return store;
  };

  // Internal mutable state
  // let: cached/components/attachedAgentId are set once during first attach()
  let cached: AttachResult | undefined;
  let components: Map<string, unknown> | undefined;
  let attachedAgentId: AgentId = agentId("unknown");

  const levels = new Map<string, SkillLoadLevel>();
  const skillSources = new Map<string, SkillSource>();
  const resolvedPaths = new Map<string, string>();
  const listeners = new Set<(event: ComponentEvent) => void>();

  // -------------------------------------------------------------------
  // attach — parallel load at "metadata" level
  // -------------------------------------------------------------------

  const attach = async (agent: Agent): Promise<AttachResult> => {
    if (cached !== undefined) {
      // Warn if a different agent re-uses this single-agent provider
      const incomingId = agent.pid?.id ?? agentId("unknown");
      if (attachedAgentId !== incomingId && (attachedAgentId as string) !== "unknown") {
        throw new Error(
          `SkillProvider is single-agent: already attached to ${attachedAgentId as string}, cannot attach to ${incomingId as string}. Create a separate provider per agent.`,
        );
      }
      return cached;
    }

    // Defensive: extract AgentId from pid.id if available, fallback for minimal stubs
    attachedAgentId = agent.pid?.id ?? agentId("unknown");
    components = new Map<string, unknown>();
    const skipped: SkippedComponent[] = [];
    const seenNames = new Set<string>();

    // Phase 1: resolve paths / validate sources sequentially (cheap I/O, needs dedup ordering)
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

      switch (skillConfig.source.kind) {
        case "filesystem": {
          const resolvedDir = resolve(basePath, skillConfig.source.path);
          const secureResult = await resolveSecurePath(resolvedDir, basePath);
          if (!secureResult.ok) {
            skipped.push({ name: skillConfig.name, reason: secureResult.error.message });
            continue;
          }
          pending.push({ kind: "filesystem", skillConfig, securePath: secureResult.value });
          break;
        }
        case "forged": {
          pending.push({ kind: "forged", skillConfig, brickId: skillConfig.source.brickId });
          break;
        }
      }
    }

    // Phase 2: load all skills in parallel at "metadata" level
    const settled = await Promise.allSettled(
      pending.map(async (p): Promise<LoadOutcome> => {
        const findingCallback =
          onSecurityFinding !== undefined
            ? (findings: readonly ScanFinding[]) => onSecurityFinding(p.skillConfig.name, findings)
            : undefined;

        switch (p.kind) {
          case "filesystem": {
            const result = await loadSkill(p.securePath, "metadata", findingCallback);
            return { skillConfig: p.skillConfig, securePath: p.securePath, result };
          }
          case "forged": {
            // store is guaranteed non-undefined by fail-fast check above
            const result = await loadForgeSkill(
              p.brickId,
              requireStore(),
              "metadata",
              findingCallback,
            );
            return { skillConfig: p.skillConfig, result };
          }
        }
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
      skillSources.set(entry.name, skillConfig.source);
      if (securePath !== undefined) {
        resolvedPaths.set(entry.name, securePath);
      }
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

    const source = skillSources.get(name);
    const findingCallback =
      onSecurityFinding !== undefined
        ? (findings: readonly ScanFinding[]) => onSecurityFinding(name, findings)
        : undefined;

    // let: loadResult assigned in exactly one branch
    let loadResult: Result<SkillEntry, KoiError>;

    if (source?.kind === "forged") {
      // store is guaranteed non-undefined by fail-fast check
      loadResult = await loadForgeSkill(source.brickId, requireStore(), target, findingCallback);
    } else {
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
      loadResult = await loadSkill(securePath, target, findingCallback);
    }

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

  // -------------------------------------------------------------------
  // mount/unmount — hot-plug serialization via promise chain
  // -------------------------------------------------------------------

  // let: pending promise chain ensures serialized mount/unmount execution
  let pending = Promise.resolve();
  // let: true while an async mount is in-flight — unmount defers to chain only when needed
  let mountInFlight = false;

  const mountImpl = async (
    skill: SkillConfig,
    mountBasePath: string,
    mountFindingCallback?: (name: string, findings: readonly ScanFinding[]) => void,
  ): Promise<Result<void, KoiError>> => {
    // Reject duplicate names
    if (levels.has(skill.name)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Skill "${skill.name}" is already mounted`,
          retryable: false,
          context: { reason: "duplicate", name: skill.name },
        },
      };
    }

    // Only filesystem sources supported for hot-mount
    if (skill.source.kind !== "filesystem") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Hot-mount only supports filesystem skills, got "${skill.source.kind}"`,
          retryable: false,
          context: { reason: "unsupported_source", kind: skill.source.kind },
        },
      };
    }

    const resolvedDir = resolve(mountBasePath, skill.source.path);
    const secureResult = await resolveSecurePath(resolvedDir, mountBasePath);
    if (!secureResult.ok) {
      return { ok: false, error: secureResult.error };
    }

    const securePath = secureResult.value;

    // Clear cache to force fresh load
    clearSkillCacheEntry(securePath);

    const findingCb =
      mountFindingCallback !== undefined
        ? (findings: readonly ScanFinding[]) => mountFindingCallback(skill.name, findings)
        : undefined;

    // Load at "body" level (Decision 14A — enables security scan)
    const loadResult = await loadSkill(securePath, "body", findingCb);
    if (!loadResult.ok) {
      return {
        ok: false,
        error: {
          ...loadResult.error,
          context: { ...loadResult.error.context, reason: "load_failed" },
        },
      };
    }

    const entry = loadResult.value;
    const component = buildSkillComponent(entry);
    const tokenKey: string = skillToken(entry.name);

    if (components !== undefined) {
      components.set(tokenKey, component);
    }
    levels.set(entry.name, "body");
    skillSources.set(entry.name, skill.source);
    resolvedPaths.set(entry.name, securePath);

    // Update cached — remove from skipped if was previously skipped
    if (cached !== undefined) {
      const filteredSkipped = cached.skipped.filter((s) => s.name !== skill.name);
      cached = { components: cached.components, skipped: filteredSkipped };
    }

    // Fire ComponentEvent
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

  const mount = (
    skill: SkillConfig,
    mountBasePath: string,
    mountFindingCallback?: (name: string, findings: readonly ScanFinding[]) => void,
  ): Promise<Result<void, KoiError>> => {
    mountInFlight = true;
    const op = pending.then(() => mountImpl(skill, mountBasePath, mountFindingCallback));
    pending = op.then(
      () => {
        mountInFlight = false;
      },
      () => {
        mountInFlight = false;
      },
    );
    return op;
  };

  const unmountImpl = (name: string): void => {
    const tokenKey: string = skillToken(name);
    const securePath = resolvedPaths.get(name);

    if (components !== undefined) {
      components.delete(tokenKey);
    }
    levels.delete(name);
    skillSources.delete(name);
    resolvedPaths.delete(name);

    // Clear cache entry
    if (securePath !== undefined) {
      clearSkillCacheEntry(securePath);
    }

    // Update cached — add to skipped with reason
    if (cached !== undefined) {
      const newSkipped = [...cached.skipped, { name, reason: "unmounted" }];
      cached = { components: cached.components, skipped: newSkipped };
    }

    // Fire ComponentEvent
    const event: ComponentEvent = {
      kind: "detached",
      agentId: attachedAgentId,
      componentKey: tokenKey,
    };
    for (const listener of listeners) {
      listener(event);
    }
  };

  const unmount = (name: string): void => {
    if (mountInFlight) {
      // Serialize with in-flight mount to prevent races on shared state
      pending = pending.then(() => {
        unmountImpl(name);
      });
    } else {
      // No mount in-flight — run synchronously for immediate observable effects
      unmountImpl(name);
    }
  };

  return {
    name: "@koi/skills",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach,
    watch,
    promote,
    getLevel,
    mount,
    unmount,
  };
}
