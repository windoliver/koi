/**
 * createSkillProvider — ComponentProvider bridge from SkillsRuntime to the agent ECS.
 *
 * This is the L3 hook: it takes a SkillsRuntime, discovers/loads skills,
 * and attaches them to an Agent as SkillComponent instances under skillToken(name) keys.
 * The engine middleware then surfaces them to the model via describeCapabilities().
 *
 * Skipped skills (NOT_FOUND, VALIDATION, PERMISSION) are reported as SkippedComponent
 * entries rather than throwing — partial success is the right behavior.
 */

import type {
  Agent,
  AttachResult,
  BrickRequires,
  ComponentProvider,
  KoiError,
  Result,
  SkillComponent,
  SubsystemToken,
} from "@koi/core";
import { COMPONENT_PRIORITY, skillToken } from "@koi/core";
import type { SkillDefinition, SkillMetadata, SkillQuery, SkillsRuntime } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SkillProviderConfig {
  /**
   * When true: validate all skills at attach time via loadAll() but attach each
   * successful skill with content: "" and runtimeBacked: true. The middleware
   * injects a compact <available_skills> XML block per model call instead of full
   * bodies, reducing per-call prompt tokens. Blocked/VALIDATION skills are still
   * reported in AttachResult.skipped for operator visibility.
   *
   * Trade-off vs. eager mode (progressive: false):
   * - Both modes call loadAll() at startup (same validation and startup cost)
   * - Progressive: ~100 tokens injected per model call (XML metadata only)
   * - Eager: body text injected at every model call (can be thousands of tokens)
   *
   * When false (default): call loadAll() and inject full bodies into systemPrompt
   * at every model call.
   */
  readonly progressive?: boolean;
}

/**
 * Creates a ComponentProvider that bridges a SkillsRuntime to the agent ECS.
 *
 * Eager mode (default, progressive: false):
 *   Calls runtime.loadAll(), converts each SkillDefinition → SkillComponent
 *   with full body in content.
 *
 * Progressive mode (progressive: true):
 *   Calls runtime.loadAll() for full blocked/VALIDATION visibility, then attaches
 *   each successful skill with content: "" and runtimeBacked: true. Bodies are
 *   discarded at attach time; the Skill tool re-loads a body on demand when the
 *   model invokes a skill. The middleware injects an <available_skills> XML block.
 *
 * NOTE: Progressive mode requires a session-pinned runtime so the advertised
 * skills and the bodies served by the Skill tool remain consistent. Use
 * `createProgressiveSkillProvider()` instead of this function in progressive
 * mode — it bundles pinning automatically and returns the pinned runtime.
 *
 * Compatible with Nexus in the future: swap the runtime implementation,
 * keep the same provider.
 */
export function createSkillProvider(
  runtime: SkillsRuntime,
  config?: SkillProviderConfig,
): ComponentProvider {
  const progressive = config?.progressive ?? false;
  if (progressive && !("clearPinnedBodies" in runtime)) {
    throw new Error(
      "createSkillProvider: progressive mode requires a session-pinned runtime. " +
        "Use createProgressiveSkillProvider() instead — it bundles pinning and " +
        "returns the pinned runtime that must also be passed to the Skill tool.",
    );
  }
  return {
    name: "skills-runtime",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach: async (_agent: Agent): Promise<AttachResult> =>
      progressive ? attachProgressive(runtime) : attachEager(runtime),
  };
}

/**
 * Creates a progressive-mode ComponentProvider with session-snapshot pinning
 * built in. Returns both the provider and the pinned runtime so callers can
 * pass the same runtime to the Skill tool — ensuring the body served on
 * demand matches exactly what was valid when the session started.
 *
 * Use this instead of `createSkillProvider(runtime, { progressive: true })`
 * to guarantee consistency without having to manually call
 * `createProgressivePinnedRuntime` at the call site.
 */
export function createProgressiveSkillProvider(base: SkillsRuntime): {
  readonly provider: ComponentProvider;
  readonly pinnedRuntime: PinnedRuntime;
  /**
   * Clears pinned bodies (+ base LRU for all pinned skills), re-runs loadAll()
   * to pick up edits/deletions, and returns a fresh typed SkillComponent map.
   *
   * Use on session reset to refresh the live skill inventory. Because named
   * invalidate() is used (not full invalidate), the discovery cache and
   * external-skill registry are preserved — newly added skills require a
   * process restart.
   */
  readonly reload: () => Promise<ReadonlyMap<SubsystemToken<SkillComponent>, SkillComponent>>;
} {
  const pinnedRuntime = createProgressivePinnedRuntime(base);
  const provider = createSkillProvider(pinnedRuntime, { progressive: true });

  const reload = async (): Promise<ReadonlyMap<SubsystemToken<SkillComponent>, SkillComponent>> => {
    // clearPinnedBodies() now also calls base.invalidate(name) for each pinned key
    // so base LRU entries are evicted before the fresh loadAll() below.
    pinnedRuntime.clearPinnedBodies();
    const result = await attachProgressive(pinnedRuntime);
    return result.components as ReadonlyMap<SubsystemToken<SkillComponent>, SkillComponent>;
  };

  return { provider, pinnedRuntime, reload };
}

// ---------------------------------------------------------------------------
// Attach strategies
// ---------------------------------------------------------------------------

async function attachEager(runtime: SkillsRuntime): Promise<AttachResult> {
  const allResult = await runtime.loadAll();
  const components = new Map<string, unknown>();
  const skipped: Array<{ readonly name: string; readonly reason: string }> = [];

  if (!allResult.ok) {
    skipped.push({ name: "__discover__", reason: allResult.error.message });
    return { components: components as ReadonlyMap<string, unknown>, skipped };
  }

  for (const [name, result] of allResult.value) {
    if (!result.ok) {
      skipped.push({ name, reason: result.error.message });
      continue;
    }
    components.set(skillToken(name), skillDefinitionToComponent(result.value));
  }

  return { components: components as ReadonlyMap<string, unknown>, skipped };
}

async function attachProgressive(runtime: SkillsRuntime): Promise<AttachResult> {
  // loadAll() gives full blocked/VALIDATION visibility for the skipped list —
  // the same parity as eager mode.
  //
  // Session-snapshot consistency: we intentionally do NOT evict skill bodies
  // from the LRU cache after attach. The advertised ECS components and the
  // cached bodies both reflect the same session-start state, so Skill tool
  // invocations always load the body that was valid when the session started.
  //
  // This prevents a stale-advertisement hazard where the middleware keeps
  // injecting a skill into <available_skills> even after its backing file is
  // deleted or becomes invalid — which would cause confusing NOT_FOUND/
  // VALIDATION errors from the Skill tool mid-session.
  //
  // Tradeoff: edits to SKILL.md after session start are not visible until the
  // next session. This is the correct model for production: consistency is
  // preferable to in-session hot-reload, and skill authors can start a new
  // session to pick up changes.
  const allResult = await runtime.loadAll();
  const components = new Map<string, unknown>();
  const skipped: Array<{ readonly name: string; readonly reason: string }> = [];

  if (!allResult.ok) {
    skipped.push({ name: "__discover__", reason: allResult.error.message });
    return { components: components as ReadonlyMap<string, unknown>, skipped };
  }

  for (const [name, result] of allResult.value) {
    if (!result.ok) {
      skipped.push({ name, reason: result.error.message });
      continue;
    }
    // MCP (source: "mcp") skills have no SKILL.md body — body is their empty
    // description. Marking them runtimeBacked would advertise them in the
    // <available_skills> XML block even though Skill() would return an empty
    // body. Use the eager helper instead so they are filtered by content === ""
    // in injectSkills, matching eager-mode behavior.
    if (result.value.source === "mcp") {
      components.set(skillToken(name), skillDefinitionToComponent(result.value));
    } else {
      components.set(skillToken(name), skillDefinitionToProgressiveComponent(result.value));
    }
  }

  return { components: components as ReadonlyMap<string, unknown>, skipped };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts a SkillDefinition to a SkillComponent (for consumers that already
 * have a loaded definition and want to attach it directly).
 */
export function skillDefinitionToComponent(skill: SkillDefinition): SkillComponent {
  return {
    name: skill.name,
    description: skill.description,
    content: skill.body,
    ...(skill.allowedTools !== undefined ? { tags: skill.allowedTools } : {}),
    ...(skill.requires !== undefined ? { requires: skill.requires as BrickRequires } : {}),
    ...(skill.executionMode !== undefined ? { executionMode: skill.executionMode } : {}),
  };
}

/**
 * Converts a loaded SkillDefinition to a progressive SkillComponent.
 * Body is discarded (content: ""); runtimeBacked: true marks this as a
 * runtime-backed progressive skill so the middleware knows it belongs in
 * <available_skills> rather than being silently excluded like MCP stubs.
 */
function skillDefinitionToProgressiveComponent(skill: SkillDefinition): SkillComponent {
  return {
    name: skill.name,
    description: skill.description,
    content: "",
    runtimeBacked: true,
    ...(skill.allowedTools !== undefined ? { tags: skill.allowedTools } : {}),
    ...(skill.requires !== undefined ? { requires: skill.requires as BrickRequires } : {}),
    ...(skill.executionMode !== undefined ? { executionMode: skill.executionMode } : {}),
  };
}

// ---------------------------------------------------------------------------
// Progressive pinned-body runtime wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a SkillsRuntime so that bodies loaded during `loadAll()` are pinned
 * in a session-local Map that is not subject to LRU eviction.
 *
 * When progressive mode is active, the provider attaches skill components
 * based on `loadAll()` results. Later `load()` calls (from the Skill tool)
 * must return the same body that was valid at session start — regardless of
 * whether the shared LRU cache has since evicted the entry or the file has
 * changed on disk.
 *
 * Use at the call site before passing the runtime to both the provider and
 * the Skill tool:
 *
 *   const runtime = createProgressivePinnedRuntime(createSkillsRuntime());
 */
/** SkillsRuntime extended with a pin-only clear for session resets. */
export type PinnedRuntime = SkillsRuntime & {
  /**
   * Clears only the session-local pin map without touching the underlying
   * base runtime's discovery cache, body cache, or external-skill registry.
   * After this call, `load()` falls through to `base.load()` for each
   * on-demand request — returning current-disk state.
   *
   * Use on session reset instead of `invalidate()` so the external-skill
   * registry and discovery state remain intact for the next session's
   * Skill tool calls.
   */
  readonly clearPinnedBodies: () => void;
};

export function createProgressivePinnedRuntime(base: SkillsRuntime): PinnedRuntime {
  const pinned = new Map<string, Result<SkillDefinition, KoiError>>();
  // let justified: mutable flag, set once after first successful loadAll()
  let pinnedPopulated = false;

  const pinnedLoad = async (name: string): Promise<Result<SkillDefinition, KoiError>> => {
    const hit = pinned.get(name);
    if (hit !== undefined) return hit;
    return base.load(name);
  };

  const pinnedLoadAll = async (): Promise<
    Result<ReadonlyMap<string, Result<SkillDefinition, KoiError>>, KoiError>
  > => {
    const result = await base.loadAll();
    if (result.ok && !pinnedPopulated) {
      pinnedPopulated = true;
      for (const [name, entry] of result.value) {
        pinned.set(name, entry);
      }
    }
    return result;
  };

  return {
    discover: (): Promise<Result<ReadonlyMap<string, SkillMetadata>, KoiError>> => base.discover(),
    load: pinnedLoad,
    loadAll: pinnedLoadAll,
    query: (filter?: SkillQuery): Promise<Result<readonly SkillMetadata[], KoiError>> =>
      base.query(filter),
    loadReference: (name: string, refPath: string): Promise<Result<string, KoiError>> =>
      base.loadReference(name, refPath),
    invalidate: (name?: string): void => {
      if (name !== undefined) {
        pinned.delete(name);
      } else {
        pinned.clear();
        pinnedPopulated = false;
      }
      base.invalidate(name);
    },
    // Do NOT evict pins on registerExternal. Session-snapshot consistency means
    // the advertised <available_skills> and the bodies served by the Skill tool
    // must both reflect the session-start state for the session's lifetime.
    // Evicting pins on MCP bridge refresh would let load() return a different
    // body than what was advertised at attach time — that breaks the invariant.
    // Hosts that need live refresh must start a new session.
    registerExternal: (skills: readonly SkillMetadata[]): void => base.registerExternal(skills),
    clearPinnedBodies: (): void => {
      // Named invalidate() clears only the body-cache entry for each skill,
      // preserving the discovery cache and external-skill registration.
      // This ensures edited/deleted skills are re-read from disk on next
      // load() while newly-added skills (not yet discovered) require a
      // full process restart.
      for (const name of pinned.keys()) {
        base.invalidate(name);
      }
      pinned.clear();
      pinnedPopulated = false;
    },
  };
}
