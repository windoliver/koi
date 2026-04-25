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

/**
 * Config for `createSkillProvider`. Reserved for future eager-mode options.
 *
 * `progressive` is intentionally `never` here — progressive mode requires
 * the pinned runtime wrapper that only `createProgressiveSkillProvider()`
 * provides. Passing `{ progressive: true }` is a compile-time error that
 * directs callers to the correct factory.
 */
export interface SkillProviderConfig {
  readonly progressive?: never;
}

/**
 * Creates a ComponentProvider that bridges a SkillsRuntime to the agent ECS.
 *
 * Eager mode only: Calls runtime.loadAll(), converts each SkillDefinition → SkillComponent
 * with full body in content. Bodies are injected into the system prompt at every
 * model call.
 *
 * For progressive mode (compact <available_skills> XML block per model call),
 * use `createProgressiveSkillProvider()` instead — it bundles session-snapshot
 * pinning automatically and returns the pinned runtime for the Skill tool.
 * Passing `progressive: true` here is intentionally unsupported: the unpinned
 * path can advertise a different skill body than the Skill tool later loads,
 * causing stale-catalog failures mid-session.
 *
 * Compatible with Nexus in the future: swap the runtime implementation,
 * keep the same provider.
 */
export function createSkillProvider(
  runtime: SkillsRuntime,
  _config?: SkillProviderConfig,
): ComponentProvider {
  return {
    name: "skills-runtime",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach: async (_agent: Agent): Promise<AttachResult> => attachEager(runtime),
  };
}

/**
 * Creates a progressive-mode ComponentProvider with session-snapshot pinning
 * built in. Returns both the provider and the pinned runtime so callers can
 * pass the same runtime to the Skill tool — ensuring the body served on
 * demand matches exactly what was valid when the session started.
 *
 * Trade-off vs. eager mode (createSkillProvider):
 * - Both modes call loadAll() at startup (same validation and startup cost)
 * - Progressive: ~100 tokens injected per model call (XML metadata only)
 * - Eager: body text injected at every model call (can be thousands of tokens)
 *
 * Blocked/VALIDATION skills are still reported in AttachResult.skipped for
 * operator visibility regardless of mode.
 */
export function createProgressiveSkillProvider(base: SkillsRuntime): {
  readonly provider: ComponentProvider;
  readonly pinnedRuntime: PinnedRuntime;
  /**
   * Atomically refreshes the skill catalog for the new session.
   *
   * Clears pinned bodies, refreshes the base runtime's discovery cache, and
   * re-runs loadAll() to pick up added/removed/edited skills. Returns a fresh
   * typed SkillComponent map on success.
   *
   * Throws if discovery fails (`loadAll` returns `{ ok: false }`). The previous
   * pinned snapshot is restored in that case so the Skill tool still serves
   * session-start bodies — preserving a consistent catalog rather than leaving
   * the runtime in a half-cleared state.
   *
   * Individual skill validation failures (skipped entries) do not cause a throw
   * — they are reported in `AttachResult.skipped` and the partial catalog is valid.
   */
  readonly reload: () => Promise<ReadonlyMap<SubsystemToken<SkillComponent>, SkillComponent>>;
} {
  const pinnedRuntime = createProgressivePinnedRuntime(base);
  const provider: ComponentProvider = {
    name: "skills-runtime",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach: async (_agent: Agent): Promise<AttachResult> => attachProgressive(pinnedRuntime),
  };

  const reload = async (): Promise<ReadonlyMap<SubsystemToken<SkillComponent>, SkillComponent>> => {
    // Snapshot current pins before clearing — used to restore on failure.
    const snapshot = pinnedRuntime.snapshotPins();
    pinnedRuntime.clearPinnedBodies();
    try {
      const result = await attachProgressive(pinnedRuntime);
      // Discovery failure surfaces as a skipped "__discover__" entry with empty components.
      // Throw so callers preserve their previous liveSkillComponents instead of replacing
      // it with an empty catalog while the pinned runtime is in a cleared state.
      const discoveryFailed = result.skipped.some((s) => s.name === "__discover__");
      if (discoveryFailed) {
        const reason =
          result.skipped.find((s) => s.name === "__discover__")?.reason ?? "skill discovery failed";
        throw new Error(reason);
      }
      return result.components as ReadonlyMap<SubsystemToken<SkillComponent>, SkillComponent>;
    } catch (err: unknown) {
      // Restore the previous pinned snapshot: load() will serve session-start bodies
      // even though the base LRU/discovery cache was cleared. Non-pinned skills fall
      // through to disk, but those were never advertised so no catalog desync occurs.
      pinnedRuntime.restorePins(snapshot);
      throw err;
    }
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
      components.set(skillToken(name), skillDefinitionToComponent(result.value, true));
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
 *
 * @param mcpBacked - Set to true for MCP-sourced skills so session-reset merge
 *   logic can exclude stale MCP entries absent from the refreshed catalog.
 */
export function skillDefinitionToComponent(
  skill: SkillDefinition,
  mcpBacked = false,
): SkillComponent {
  return {
    name: skill.name,
    description: skill.description,
    content: skill.body,
    ...(mcpBacked ? { mcpBacked: true } : {}),
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
   * Clears pinned bodies and invalidates the corresponding base LRU entries,
   * then clears the base runtime's discovery cache so the next `loadAll()`
   * re-scans the filesystem. The most recent `registerExternal()` snapshot is
   * re-applied immediately, honoring full-replacement semantics — stale skills
   * from disconnected MCP servers are not resurrected.
   *
   * Use on session reset to pick up added/removed filesystem skills and refreshed
   * skill bodies. The last external snapshot is replayed on the base runtime after
   * the full invalidation so currently-connected MCP skills survive the reset.
   */
  readonly clearPinnedBodies: () => void;
  /**
   * Returns a shallow copy of the current pinned bodies map for transactional
   * use. Use with `restorePins()` to implement atomic reload: snapshot before
   * clearing, restore on failure.
   */
  readonly snapshotPins: () => ReadonlyMap<string, Result<SkillDefinition, KoiError>>;
  /**
   * Replaces the current pinned bodies with the provided snapshot. Used after a
   * failed reload to restore the previous session-start state. Pinned entries take
   * priority in `load()`, so restoring the snapshot means the Skill tool still
   * returns session-start bodies even after a failed base invalidation.
   */
  readonly restorePins: (snapshot: ReadonlyMap<string, Result<SkillDefinition, KoiError>>) => void;
};

export function createProgressivePinnedRuntime(base: SkillsRuntime): PinnedRuntime {
  const pinned = new Map<string, Result<SkillDefinition, KoiError>>();
  // Snapshot of the last registerExternal() call. The SkillsRuntime contract
  // specifies full replacement semantics — each call replaces all previous
  // externals. We honor that here: clearPinnedBodies() replays only the most
  // recent snapshot, so a disconnected MCP server's stale skills are not
  // re-registered on session reset.
  let lastExternalSkills: readonly SkillMetadata[] = [];

  const pinnedLoad = async (name: string): Promise<Result<SkillDefinition, KoiError>> => {
    const hit = pinned.get(name);
    if (hit !== undefined) return hit;
    return base.load(name);
  };

  const pinnedLoadAll = async (): Promise<
    Result<ReadonlyMap<string, Result<SkillDefinition, KoiError>>, KoiError>
  > => {
    const result = await base.loadAll();
    // Only pin when the map is empty (first call per session, or after clearPinnedBodies).
    // This scopes pins to one session: once pinned, a second loadAll() during the same
    // session cannot overwrite the snapshot with different disk state. clearPinnedBodies()
    // empties the map so the next session's loadAll() re-pins fresh state.
    if (result.ok && pinned.size === 0) {
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
      }
      base.invalidate(name);
    },
    registerExternal: (skills: readonly SkillMetadata[]): void => {
      // Honor full-replacement semantics from the SkillsRuntime contract:
      // each call replaces the entire external set, so we track only the latest.
      lastExternalSkills = skills;
      base.registerExternal(skills);
    },
    clearPinnedBodies: (): void => {
      // Full base invalidation clears the discovery cache so the next loadAll()
      // re-scans the filesystem, picking up newly added or removed skill directories.
      // External/MCP skills are cleared too by base.invalidate(), but are immediately
      // re-registered from the last known snapshot to restore the session-start state.
      base.invalidate();
      if (lastExternalSkills.length > 0) {
        base.registerExternal(lastExternalSkills);
      }
      pinned.clear();
    },
    snapshotPins: (): ReadonlyMap<string, Result<SkillDefinition, KoiError>> => new Map(pinned),
    restorePins: (snapshot: ReadonlyMap<string, Result<SkillDefinition, KoiError>>): void => {
      pinned.clear();
      for (const [name, entry] of snapshot) {
        pinned.set(name, entry);
      }
    },
  };
}
