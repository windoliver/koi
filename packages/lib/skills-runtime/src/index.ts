/**
 * @koi/skills-runtime — Multi-source skill discovery and loading for Koi agents.
 *
 * L2 package. Imports from @koi/core (L0) and L0u utilities only.
 *
 * Usage:
 *   import { createSkillsRuntime } from "@koi/skills-runtime";
 *   const runtime = createSkillsRuntime({ blockOnSeverity: "HIGH" });
 *   const meta = await runtime.discover();   // frontmatter only, no body
 *   const result = await runtime.load("code-review");  // full body + scan
 *   const filtered = await runtime.query({ tags: ["typescript"] });
 */

import { join } from "node:path";
import type { KoiError, Result } from "@koi/core";
import type { ScanFinding, Scanner } from "@koi/skill-scanner";
import { createScanner } from "@koi/skill-scanner";
import { type Severity, severityAtOrAbove } from "@koi/validation";
import type { DiscoverConfig, DiscoveredSkillEntry } from "./discover.js";
import { discoverSkills, resolveSingleSkill } from "./discover.js";
import { loadReference, validateReferencePath } from "./load-reference.js";
import type { LoaderContext } from "./loader.js";
import { loadSkill } from "./loader.js";
import { createBodyCache } from "./lru-cache.js";
import { parseSkillMd } from "./parse.js";
import type { ResolvedInclude } from "./resolve-includes.js";
import { resolveIncludes } from "./resolve-includes.js";
import type {
  SkillDefinition,
  SkillEvictedEvent,
  SkillLoadedEvent,
  SkillMetadata,
  SkillQuery,
  SkillSource,
  SkillsRuntime,
  SkillsRuntimeConfig,
} from "./types.js";
import { validateFrontmatter } from "./validate.js";

export type { SkillSpawnRequest } from "./execution.js";
export { mapSkillToSpawnRequest } from "./execution.js";
export { mapFrontmatterToDefinition, mapFrontmatterToMetadata } from "./map-frontmatter.js";
export type { SkillInjectorConfig } from "./middleware.js";
export { createSkillInjectorMiddleware } from "./middleware.js";
export { createSkillProvider, skillDefinitionToComponent } from "./provider.js";
export type {
  SkillEvictedEvent,
  SkillLoadedEvent,
  ValidatedFrontmatter,
  ValidatedSkillRequires,
} from "./types.js";
export type {
  SkillDefinition,
  SkillMetadata,
  SkillQuery,
  SkillSource,
  SkillsRuntime,
  SkillsRuntimeConfig,
};

// ---------------------------------------------------------------------------
// Discover-time security scan (issue #1722)
// ---------------------------------------------------------------------------

interface BlockedEntry {
  readonly entry: DiscoveredSkillEntry;
  readonly findings: readonly ScanFinding[];
}

interface ScanSplit {
  readonly clean: ReadonlyMap<string, DiscoveredSkillEntry>;
  readonly blocked: ReadonlyMap<string, BlockedEntry>;
}

/**
 * Scans each discovered skill's SKILL.md body BEFORE it enters the registry.
 *
 * Issue #1722: until this ran, a malicious skill with clean frontmatter but
 * a destructive body (`rm -rf /` or `$OPENROUTER_API_KEY` exfiltration in
 * prose) was advertised via discover()/query()/describeCapabilities and only
 * rejected when a caller invoked load() — too late, since the metadata had
 * already reached the model.
 *
 * Entries with at least one finding at or above `blockOnSeverity` are moved
 * to the `blocked` map — they are excluded from discover()/query() (so the
 * model never sees them) but load()/loadAll() still surface them with a
 * PERMISSION error for operator observability. Sub-threshold findings route
 * through `onSecurityFinding`. Read errors are tolerated — the load() path
 * will surface a proper NOT_FOUND later.
 */
/**
 * Reads SKILL.md content and resolves any `includes:` frontmatter items
 * using the same `parseSkillMd` + `resolveIncludes` pipeline as the loader,
 * returning the concatenated body for scanning.
 *
 * Reuses the loader's include resolution so path boundary enforcement,
 * recursion limits, and YAML parsing are identical (issue #1722 round 5).
 *
 * Shared between `scanDiscoveredEntries` and `rescanBlockedSkills`.
 */
async function readFullSkillContent(
  content: string,
  dirPath: string,
  skillsRoot: string,
): Promise<
  | { readonly ok: true; readonly fullContent: string }
  | { readonly ok: false; readonly finding: ScanFinding }
> {
  const parsed = parseSkillMd(content, join(dirPath, "SKILL.md"));
  if (!parsed.ok) {
    // Unparseable frontmatter — fail closed
    return {
      ok: false,
      finding: {
        rule: "unparseable-skill-frontmatter",
        severity: "HIGH",
        confidence: 1.0,
        category: "UNPARSEABLE",
        message: `SKILL.md frontmatter could not be parsed: ${parsed.error.message}`,
      },
    };
  }

  const rawIncludes = parsed.value.frontmatter.includes;
  if (!Array.isArray(rawIncludes) || rawIncludes.length === 0) {
    return { ok: true, fullContent: content };
  }

  const includes = rawIncludes.filter((i: unknown): i is string => typeof i === "string");
  const includeResult = await resolveIncludes(includes, dirPath, skillsRoot);
  if (!includeResult.ok) {
    return {
      ok: false,
      finding: {
        rule: "unreadable-skill-include",
        severity: "HIGH",
        confidence: 1.0,
        category: "UNPARSEABLE",
        message: `Include resolution failed at discovery time: ${includeResult.error.message}`,
      },
    };
  }

  const appendix = includeResult.value.map((inc: ResolvedInclude) => inc.content).join("\n\n");
  const fullContent = appendix.length > 0 ? `${content}\n\n${appendix}` : content;
  return { ok: true, fullContent };
}

async function scanDiscoveredEntries(
  entries: ReadonlyMap<string, DiscoveredSkillEntry>,
  scanner: Scanner,
  blockOnSeverity: Severity,
  onSecurityFinding?: (name: string, findings: readonly ScanFinding[]) => void,
): Promise<ScanSplit> {
  const results = await Promise.all(
    [...entries.entries()].map(async ([name, entry]) => {
      const skillMdPath = join(entry.dirPath, "SKILL.md");
      let content: string; // let: assigned in try/catch
      try {
        content = await Bun.file(skillMdPath).text();
      } catch {
        // Unreadable at discovery time — fail closed. Reserve the name as
        // blocked so the unscanned body cannot surface via discover()/
        // query()/describeCapabilities, and so operators get a PERMISSION
        // signal from load()/loadAll() instead of a silent NOT_FOUND.
        const finding: ScanFinding = {
          rule: "unreadable-skill-body",
          severity: "HIGH",
          confidence: 1.0,
          category: "UNPARSEABLE",
          message: `SKILL.md could not be read at discovery time: ${skillMdPath}`,
        };
        return { name, entry, blocking: [finding] as readonly ScanFinding[] };
      }

      // Issue #1722 round 3+4+5+6: scan SKILL.md + included files together
      // using the same resolveIncludes pipeline as the loader. Parse and
      // include failures are routed through the normal threshold filter
      // (round 6) so blockOnSeverity is respected.
      const resolved = await readFullSkillContent(content, entry.dirPath, entry.skillsRoot);
      if (!resolved.ok) {
        if (severityAtOrAbove(resolved.finding.severity, blockOnSeverity)) {
          return { name, entry, blocking: [resolved.finding] as readonly ScanFinding[] };
        }
        onSecurityFinding?.(name, [resolved.finding]);
        // Below threshold — scan the base content without includes
      }

      const report = scanner.scanSkill(resolved.ok ? resolved.fullContent : content);
      if (report.findings.length === 0) {
        return { name, entry, blocking: [] as readonly ScanFinding[] };
      }

      const blocking = report.findings.filter((f) =>
        severityAtOrAbove(f.severity, blockOnSeverity),
      );
      const nonBlocking = report.findings.filter(
        (f) => !severityAtOrAbove(f.severity, blockOnSeverity),
      );

      if (nonBlocking.length > 0) {
        onSecurityFinding?.(name, nonBlocking);
      }

      return { name, entry, blocking };
    }),
  );

  const clean = new Map<string, DiscoveredSkillEntry>();
  const blocked = new Map<string, BlockedEntry>();
  for (const { name, entry, blocking } of results) {
    if (blocking.length > 0) {
      blocked.set(name, { entry, findings: blocking });
    } else {
      clean.set(name, entry);
    }
  }
  return { clean, blocked };
}

/**
 * Per-skill decision emitted by `rescanBlockedSkills()`.
 *
 * The commit step applies decisions one-by-one, gated by a per-name
 * generation check so a skill re-invalidated during the async rescan
 * window is never committed with stale data.
 */
type RescanDecision =
  | { readonly kind: "promoted"; readonly entry: DiscoveredSkillEntry }
  | {
      readonly kind: "stillBlocked";
      readonly entry: DiscoveredSkillEntry;
      readonly findings: readonly ScanFinding[];
    }
  | { readonly kind: "released" }
  | { readonly kind: "keep" };

/**
 * Re-scans a small set of previously-blocked skills (issue #1722 recovery path).
 *
 * Used by `invalidate(name)` so that editing one blocked SKILL.md in place
 * can promote it back to the discovered map without forcing a full
 * filesystem re-walk that would also re-discover every unrelated skill.
 * Only the requested names are re-read + re-scanned; every other entry in
 * `currentDiscovered` and `currentBlocked` is copied through untouched.
 *
 * Uses `resolveSingleSkill()` so tier precedence (project > user > bundled)
 * is honored: if a higher-priority skill with the same name was added after
 * the original block, the rescan sees it; if the old tier's copy was
 * removed but a lower-tier copy still exists, that lower tier wins.
 *
 * Returns per-skill decisions (rather than pre-merged maps) so the caller
 * can gate each application on the per-name generation snapshot captured
 * before the async work started — a name that was re-invalidated during
 * the rescan is `keep`'d and deferred to the next rescan rather than
 * publishing the already-superseded snapshot.
 *
 * Decision kinds:
 * - `promoted` — scan came back clean; move to discovered map.
 * - `stillBlocked` — findings above threshold; replace in blocked map.
 * - `released` — all tiers confirm missing; drop the reservation.
 * - `keep` — unreadable/transient; keep existing state as-is.
 */
async function rescanBlockedSkills(
  pendingNames: ReadonlySet<string>,
  currentBlocked: ReadonlyMap<string, BlockedEntry>,
  scanner: Scanner,
  blockOnSeverity: Severity,
  discoverConfig: DiscoverConfig,
  onSecurityFinding?: (name: string, findings: readonly ScanFinding[]) => void,
): Promise<ReadonlyMap<string, RescanDecision>> {
  const decisions = new Map<string, RescanDecision>();

  await Promise.all(
    [...pendingNames].map(async (name) => {
      if (!currentBlocked.has(name)) {
        decisions.set(name, { kind: "keep" });
        return;
      }

      // Re-run tier resolution — don't just re-read the stale dirPath.
      const resolved = await resolveSingleSkill(name, discoverConfig);

      if (resolved === "unreadable") {
        decisions.set(name, { kind: "keep" });
        return;
      }

      if (resolved === "not-found") {
        decisions.set(name, { kind: "released" });
        return;
      }

      // Winning tier owns the skill — re-read + re-scan body + includes.
      const skillMdPath = join(resolved.dirPath, "SKILL.md");
      let content: string; // let: assigned in try/catch
      try {
        content = await Bun.file(skillMdPath).text();
      } catch {
        decisions.set(name, { kind: "keep" });
        return;
      }

      // Issue #1722 round 4+5+6: rescan must also resolve includes, same
      // as the initial discover-time scan path. Parse/include failures
      // respect blockOnSeverity threshold.
      const fullResult = await readFullSkillContent(content, resolved.dirPath, resolved.skillsRoot);
      if (!fullResult.ok) {
        if (severityAtOrAbove(fullResult.finding.severity, blockOnSeverity)) {
          decisions.set(name, {
            kind: "stillBlocked",
            entry: resolved,
            findings: [fullResult.finding],
          });
          return;
        }
        onSecurityFinding?.(name, [fullResult.finding]);
      }

      const report = scanner.scanSkill(fullResult.ok ? fullResult.fullContent : content);
      const blocking = report.findings.filter((f) =>
        severityAtOrAbove(f.severity, blockOnSeverity),
      );
      const nonBlocking = report.findings.filter(
        (f) => !severityAtOrAbove(f.severity, blockOnSeverity),
      );
      if (nonBlocking.length > 0) onSecurityFinding?.(name, nonBlocking);

      if (blocking.length > 0) {
        decisions.set(name, { kind: "stillBlocked", entry: resolved, findings: blocking });
      } else {
        decisions.set(name, { kind: "promoted", entry: resolved });
      }
    }),
  );

  return decisions;
}

function buildBlockedResult(
  name: string,
  blockOnSeverity: Severity,
  findings: readonly ScanFinding[],
): Result<SkillDefinition, KoiError> {
  const summary = findings.map((f) => `[${f.severity}] ${f.rule}: ${f.message}`).join("; ");
  return {
    ok: false,
    error: {
      code: "PERMISSION",
      message: `Skill "${name}" blocked by discover-time security scan (${findings.length} finding(s) at or above ${blockOnSeverity}): ${summary}`,
      retryable: false,
      context: { name, blockOnSeverity, findings },
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an instance-scoped SkillsRuntime.
 *
 * The scanner, body cache, and discovered entries all live inside this instance —
 * no global state (Decision 2A, 13A).
 *
 * Concurrency safety (Issue 2A): discover() and load() both use inflight promise
 * deduplication — concurrent calls for the same resource join a single in-flight
 * operation rather than triggering duplicate filesystem scans or loads.
 */
export function createSkillsRuntime(config?: SkillsRuntimeConfig): SkillsRuntime {
  const resolvedConfig: {
    readonly blockOnSeverity: Severity;
    readonly onShadowedSkill?: (name: string, shadowedBy: SkillSource) => void;
    readonly onSecurityFinding?: (name: string, findings: readonly ScanFinding[]) => void;
  } = {
    blockOnSeverity: (config?.blockOnSeverity ?? "HIGH") as Severity,
    ...(config?.onShadowedSkill !== undefined ? { onShadowedSkill: config.onShadowedSkill } : {}),
    ...(config?.onSecurityFinding !== undefined
      ? { onSecurityFinding: config.onSecurityFinding }
      : {}),
  };

  // Decision 13A: instance-scoped scanner (no module-level global)
  const scanner = createScanner();

  // Issue #1642: instance-scoped LRU body cache. `cacheMaxBodies` of
  // Infinity / 0 / negative preserves legacy unbounded behavior.
  const onSkillEvicted = config?.onSkillEvicted;
  const cache = createBodyCache<Result<SkillDefinition, KoiError>>({
    max: config?.cacheMaxBodies ?? Number.POSITIVE_INFINITY,
    ...(onSkillEvicted !== undefined
      ? {
          onEvict: (e) => {
            onSkillEvicted({ name: e.key, reason: e.reason } satisfies SkillEvictedEvent);
          },
        }
      : {}),
  });

  const onSkillLoaded = config?.onSkillLoaded;
  const onMetadataInjected = config?.onMetadataInjected;
  const emitLoaded = (
    name: string,
    result: Result<SkillDefinition, KoiError>,
    cacheHit: boolean,
  ): void => {
    if (onSkillLoaded === undefined) return;
    if (!result.ok) return;
    const event: SkillLoadedEvent = {
      name,
      source: result.value.source,
      bodyBytes: result.value.body.length,
      cacheHit,
    };
    onSkillLoaded(event);
  };

  // Issue 4A: single merged map (source + dirPath + skillsRoot + metadata)
  // replaces the previous two separate Maps (discoveredSkills + discoveredDirPaths).
  let discoveredEntry: ReadonlyMap<string, DiscoveredSkillEntry> | undefined;
  // Issue #1722: skills excluded from discover() by the discover-time security
  // scan. Kept separate so loadAll() / provider.skipped can still surface them.
  let blockedEntry: ReadonlyMap<string, BlockedEntry> = new Map();
  // Issue #1722: names flagged by `invalidate(name)` for a targeted re-read +
  // re-scan on the next `discover()` call. Scoped to specific blocked skills
  // so unrelated cached metadata survives. Each entry is tagged with a
  // per-name generation counter: a rescan only clears names whose generation
  // was not bumped by a concurrent `invalidate(name)` during the async
  // window, so rapid successive invalidations cannot be lost.
  const pendingRescan = new Map<string, number>();
  let nextPendingGen = 0;
  // Issue #1722 round 2: names whose SKILL.md was unreadable at discovery
  // time (transient I/O, atomic replace, etc.). These are kept in
  // `blockedEntry` fail-closed, and are auto-promoted to `pendingRescan`
  // on discover() calls where `Date.now() >= nextRetryAt` — so transient
  // unreadable states recover without requiring an explicit
  // `invalidate(name)`, but a stable permission problem does not flood
  // the runtime with rescans on every discover()/load()/query() call.
  // Value is the earliest timestamp (ms) at which the next auto-retry is
  // allowed. Exponential backoff: start at ~250ms, double per failure,
  // capped at 60s.
  const quarantinedUnreadable = new Map<string, number>();
  const quarantineBackoff = new Map<string, number>();
  const QUARANTINE_MIN_BACKOFF_MS = 250;
  const QUARANTINE_MAX_BACKOFF_MS = 60_000;
  // Issue #1722: inflight dedup for the targeted rescan path — concurrent
  // discover()/load()/query() callers join the same pending rescan rather
  // than observing stale discoveredMetaMap/blockedEntry during the await.
  let rescanInflight: Promise<void> | undefined;
  // Issue #1722: monotonic runtime generation token. Incremented by
  // `invalidate()` (full reset). In-flight discover / rescan promises check
  // this before committing so a stale async completion cannot repopulate
  // state after a reset.
  let runtimeGeneration = 0;
  // Per-skill generation counters (review #1896 round 12). `invalidate(name)`
  // bumps the entry for that skill so a concurrent load(name) whose async
  // work finishes afterward refuses to write its stale body back to the
  // cache. The runtime-wide `runtimeGeneration` covers reset and external-
  // refresh, but not targeted invalidation — without this per-skill
  // counter, `invalidate(name)` had no way to revoke an in-flight load.
  const skillGeneration = new Map<string, number>();
  const getSkillGeneration = (n: string): number => skillGeneration.get(n) ?? 0;
  // Projected metadata map cached to preserve reference identity across discover() calls.
  // Rebuilt whenever filesystem or external entries change.
  let discoveredMetaMap: ReadonlyMap<string, SkillMetadata> | undefined;

  // External (non-filesystem) skills — separate lifecycle from filesystem cache.
  // Replaced atomically by registerExternal(). Not cleared by filesystem re-scan.
  let externalSkills: ReadonlyMap<string, SkillMetadata> = new Map();

  // Issue 2A: inflight deduplication for discover()
  let discoverInflight:
    | Promise<Result<ReadonlyMap<string, DiscoveredSkillEntry>, KoiError>>
    | undefined;

  // Issue 2A: inflight deduplication for load() — one promise per skill name
  const loadInflight = new Map<string, Promise<Result<SkillDefinition, KoiError>>>();

  const discoverConfig: DiscoverConfig = {
    ...(config?.projectRoot !== undefined ? { projectRoot: config.projectRoot } : {}),
    ...(config?.userRoot !== undefined ? { userRoot: config.userRoot } : {}),
    // bundledRoot: null means disabled; undefined means use default
    ...(config?.bundledRoot !== undefined ? { bundledRoot: config.bundledRoot } : {}),
    ...(resolvedConfig.onShadowedSkill !== undefined
      ? { onShadowedSkill: resolvedConfig.onShadowedSkill }
      : {}),
  };

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Builds the merged metadata map: external (lowest priority) + filesystem entries.
   * Filesystem entries always shadow external entries of the same name.
   *
   * Issue #1722 regression: blocked filesystem names also shadow external
   * entries. Without this, a filesystem skill rejected by the discover-time
   * scanner would silently let a same-named external (MCP) skill surface
   * under its name — the model would see external metadata while `load()`
   * routes to the blocked filesystem entry and returns `PERMISSION`. Blocked
   * filesystem names are treated as reserved.
   */
  function buildMergedMetaMap(
    fsEntries: ReadonlyMap<string, DiscoveredSkillEntry>,
    external: ReadonlyMap<string, SkillMetadata>,
    blocked: ReadonlyMap<string, BlockedEntry>,
  ): ReadonlyMap<string, SkillMetadata> {
    const merged = new Map<string, SkillMetadata>();
    // External is lowest priority — and blocked filesystem names are reserved.
    for (const [k, v] of external) {
      if (!blocked.has(k)) merged.set(k, v);
    }
    // Filesystem entries shadow external.
    for (const [k, v] of fsEntries) {
      merged.set(k, v.metadata);
    }
    return merged;
  }

  // ---------------------------------------------------------------------------
  // discover()
  // ---------------------------------------------------------------------------

  // Track the external map version that was used to build discoveredMetaMap.
  // When registerExternal() replaces the map, this goes stale and triggers a rebuild.
  let lastExternalRef: ReadonlyMap<string, SkillMetadata> = externalSkills;

  const discoverInternal = async (): Promise<
    Result<ReadonlyMap<string, SkillMetadata>, KoiError>
  > => {
    // Issue #1722 round 10: a generation mismatch (invalidate() racing
    // with an in-flight rescan/discover) must not surface as INTERNAL.
    // Instead we loop and restart against the fresh state. There is no
    // retry cap: the loop converges naturally once invalidate() stops
    // firing, and any bounded cap would turn routine editor/watcher
    // churn into a visible availability regression.
    //
    // Issue #1722 round 2: auto-promote quarantined-unreadable entries to
    // `pendingRescan` once per outer call. Doing this once (not once per
    // while-loop iteration) prevents an infinite loop when rescan returns
    // a "keep" decision for a still-unreadable skill.
    let autoPromotedUnreadable = false;
    while (true) {
      if (!autoPromotedUnreadable && quarantinedUnreadable.size > 0) {
        const now = Date.now();
        for (const [name, nextRetryAt] of quarantinedUnreadable) {
          if (now < nextRetryAt) continue;
          if (!pendingRescan.has(name)) {
            nextPendingGen += 1;
            pendingRescan.set(name, nextPendingGen);
          }
        }
        autoPromotedUnreadable = true;
      }

      // Issue #1722: if a targeted rescan is already in flight, join it
      // before reading cached state. This closes the race where a
      // concurrent caller would otherwise observe the pre-rescan
      // discoveredMetaMap.
      if (rescanInflight !== undefined) {
        await rescanInflight;
      }

      // Fast path: filesystem cache valid AND external map unchanged AND
      // no pending per-skill rescans → return cached merge.
      if (
        discoveredEntry !== undefined &&
        discoveredMetaMap !== undefined &&
        lastExternalRef === externalSkills &&
        pendingRescan.size === 0
      ) {
        return { ok: true, value: discoveredMetaMap };
      }

      // Issue #1722: pending rescan path — `invalidate(name)` flagged one
      // or more blocked skills for re-read + re-scan. Update only those
      // entries and rebuild the merged map; unrelated cached metadata
      // survives. The work is wrapped in `rescanInflight` so concurrent
      // discover()/load() callers arriving mid-rescan join the same
      // promise instead of hitting the stale fast path.
      if (discoveredEntry !== undefined && pendingRescan.size > 0) {
        // Snapshot per-name generations so a concurrent `invalidate(name)`
        // during the async rescan window bumps the generation and is not
        // silently coalesced away on completion.
        const snapshotGenerations = new Map(pendingRescan);
        const namesToRescan = new Set(snapshotGenerations.keys());
        const discoveredSnapshot = discoveredEntry;
        const blockedSnapshot = blockedEntry;
        const rescanRuntimeGen = runtimeGeneration;
        rescanInflight = (async () => {
          try {
            const decisions = await rescanBlockedSkills(
              namesToRescan,
              blockedSnapshot,
              scanner,
              resolvedConfig.blockOnSeverity,
              discoverConfig,
              resolvedConfig.onSecurityFinding,
            );
            // Generation guard: if a full `invalidate()` landed during
            // the rescan, discard the result rather than repopulating
            // stale state.
            if (rescanRuntimeGen !== runtimeGeneration) return;
            const nextDiscovered = new Map(discoveredSnapshot);
            const nextBlocked = new Map(blockedSnapshot);
            for (const [n, decision] of decisions) {
              // Per-name gen guard: skip any name that was re-invalidated
              // during the async window. Its `pendingRescan` entry now
              // has a higher generation than the snapshot — we leave the
              // existing blocked/discovered state untouched and defer to
              // the next rescan.
              if (pendingRescan.get(n) !== snapshotGenerations.get(n)) continue;
              switch (decision.kind) {
                case "promoted":
                  nextBlocked.delete(n);
                  nextDiscovered.set(n, decision.entry);
                  cache.delete(n);
                  loadInflight.delete(n);
                  quarantinedUnreadable.delete(n);
                  quarantineBackoff.delete(n);
                  break;
                case "stillBlocked":
                  nextBlocked.set(n, { entry: decision.entry, findings: decision.findings });
                  cache.delete(n);
                  loadInflight.delete(n);
                  quarantinedUnreadable.delete(n);
                  quarantineBackoff.delete(n);
                  break;
                case "released":
                  nextBlocked.delete(n);
                  nextDiscovered.delete(n);
                  cache.delete(n);
                  loadInflight.delete(n);
                  quarantinedUnreadable.delete(n);
                  quarantineBackoff.delete(n);
                  break;
                case "keep": {
                  // Transient I/O or unreadable — leave maps alone and
                  // schedule the next auto-retry with exponential backoff
                  // capped at QUARANTINE_MAX_BACKOFF_MS. This gives
                  // persistent permission failures a bounded recovery
                  // path without flooding the runtime with rescans on
                  // every call.
                  const prev = quarantineBackoff.get(n) ?? QUARANTINE_MIN_BACKOFF_MS;
                  const next = Math.min(prev * 2, QUARANTINE_MAX_BACKOFF_MS);
                  quarantineBackoff.set(n, next);
                  quarantinedUnreadable.set(n, Date.now() + next);
                  break;
                }
              }
              pendingRescan.delete(n);
            }
            discoveredEntry = nextDiscovered;
            blockedEntry = nextBlocked;
            discoveredMetaMap = buildMergedMetaMap(nextDiscovered, externalSkills, nextBlocked);
            lastExternalRef = externalSkills;
          } finally {
            rescanInflight = undefined;
          }
        })();
        await rescanInflight;
        // On gen mismatch (or re-invalidation leaving pending entries),
        // restart the loop so the caller sees the fresh state.
        continue;
      }

      // If filesystem is cached but external changed, just rebuild the
      // merged map.
      if (discoveredEntry !== undefined && lastExternalRef !== externalSkills) {
        discoveredMetaMap = buildMergedMetaMap(discoveredEntry, externalSkills, blockedEntry);
        lastExternalRef = externalSkills;
        return { ok: true, value: discoveredMetaMap };
      }

      // Inflight dedup: join the in-flight promise if discovery is
      // already running.
      if (discoverInflight !== undefined) {
        const result = await discoverInflight;
        if (!result.ok) return result;
        // Generation guard may have caused the commit to be skipped;
        // loop to re-read fresh state instead of returning INTERNAL.
        if (discoveredMetaMap === undefined) continue;
        return { ok: true, value: discoveredMetaMap };
      }

      // No cache, no in-flight — start filesystem discovery.
      // Issue #1722: run the scanner on each discovered skill BEFORE it enters
      // the registry, so malicious SKILL.md bodies are never advertised via
      // discover()/query()/describeCapabilities. Sub-threshold findings route
      // through onSecurityFinding; blocking findings move the entry into
      // blockedEntry (still surfaced via loadAll() as PERMISSION errors).
      const discoverRuntimeGen = runtimeGeneration;
      discoverInflight = discoverSkills(discoverConfig)
        .then(async (result) => {
          if (!result.ok) return result;
          const split = await scanDiscoveredEntries(
            result.value,
            scanner,
            resolvedConfig.blockOnSeverity,
            resolvedConfig.onSecurityFinding,
          );
          // Generation guard: if a full `invalidate()` landed while the walk
          // + scan was running, return the walk result to any joined caller
          // but do NOT commit — the next commit step sees the mismatch and
          // skips publishing.
          return { ok: true, value: split } satisfies Result<ScanSplit, KoiError>;
        })
        .then(
          (result) => {
            const stale = discoverRuntimeGen !== runtimeGeneration;
            if (result.ok && !stale) {
              const split = result.value;
              // Evict stale cached/inflight definitions for any name now
              // blocked — a previously cached clean body (e.g. cached
              // external definition for the same name) must not leak past
              // the new blocked reservation.
              for (const n of split.blocked.keys()) {
                cache.delete(n);
                loadInflight.delete(n);
              }
              discoveredEntry = split.clean;
              blockedEntry = split.blocked;
              discoveredMetaMap = buildMergedMetaMap(split.clean, externalSkills, split.blocked);
              lastExternalRef = externalSkills;
              // Refresh the quarantined-unreadable set so the next
              // discover() auto-retries any skill that was only blocked
              // because its body could not be read at discovery time.
              // Initial retry window is 0 (immediate) — the backoff only
              // kicks in after the first failed rescan.
              quarantinedUnreadable.clear();
              quarantineBackoff.clear();
              for (const [n, be] of split.blocked) {
                if (be.findings.some((f) => f.rule === "unreadable-skill-body")) {
                  quarantinedUnreadable.set(n, 0);
                }
              }
            }
            discoverInflight = undefined;
            if (!result.ok) return result;
            return { ok: true, value: result.value.clean } satisfies Result<
              ReadonlyMap<string, DiscoveredSkillEntry>,
              KoiError
            >;
          },
          (err: unknown) => {
            discoverInflight = undefined;
            throw err;
          },
        );

      const result = await discoverInflight;
      if (!result.ok) return result;
      // Generation guard may have skipped commit; loop instead of INTERNAL.
      if (discoveredMetaMap === undefined) continue;
      return { ok: true, value: discoveredMetaMap };
    }
  };

  // ---------------------------------------------------------------------------
  // load()
  // ---------------------------------------------------------------------------

  const load = async (name: string): Promise<Result<SkillDefinition, KoiError>> => {
    // 1. Body cache hit
    const cached = cache.get(name);
    if (cached !== undefined) {
      emitLoaded(name, cached, true);
      return cached;
    }

    // 2. Inflight dedup: join if this skill is already loading.
    // Both checks below are synchronous — no interleave between check and registration.
    const inflight = loadInflight.get(name);
    if (inflight !== undefined) return inflight;

    // Snapshot the runtime + per-skill generation so we can suppress cache
    // writes from load() calls whose async work finishes after a concurrent
    // invalidate() / invalidate(name) / registerExternal() — review #1896
    // rounds 11 and 12.
    const loadStartGeneration = runtimeGeneration;
    const loadStartSkillGen = getSkillGeneration(name);
    const shouldCommit = (): boolean =>
      runtimeGeneration === loadStartGeneration && getSkillGeneration(name) === loadStartSkillGen;

    // 3. Create the load promise and register it synchronously before any await.
    //    This closes the race window: any concurrent caller arriving after this
    //    point will find the promise in loadInflight and join it.
    const promise: Promise<Result<SkillDefinition, KoiError>> = (async () => {
      // Ensure discovery has run. Use the internal helper so Tier 0
      // telemetry (onMetadataInjected) is not re-fired by routine load()
      // calls — review #1896 round 3.
      const discoverResult = await discoverInternal();
      if (!discoverResult.ok) return discoverResult;

      // Issue #1722: blocked-at-discovery entries short-circuit with a
      // PERMISSION error — they are kept out of discoveredEntry but still
      // surfaced here for operator visibility (loadAll → provider.skipped).
      // NOT cached: the blocked reservation is authoritative and can
      // change under `invalidate(name)` + rescan, so every call must read
      // live `blockedEntry` state.
      const blocked = blockedEntry.get(name);
      if (blocked !== undefined) {
        return buildBlockedResult(name, resolvedConfig.blockOnSeverity, blocked.findings);
      }

      // Check filesystem entries first (higher priority)
      const entry = discoveredEntry?.get(name);
      if (entry !== undefined) {
        const ctx: LoaderContext = {
          cache,
          scanner,
          skillsRoot: entry.skillsRoot,
          config: resolvedConfig,
          onLoad: emitLoaded,
          shouldCommit,
        };
        return loadSkill(name, entry.dirPath, entry.source, ctx);
      }

      // Check external entries (MCP-derived skills)
      const extSkill = externalSkills.get(name);
      if (extSkill !== undefined) {
        const extCached = cache.get(name);
        if (extCached !== undefined) {
          emitLoaded(name, extCached, true);
          return extCached;
        }
        // External skills have no filesystem body — generate a minimal SkillDefinition.
        // Body is the description (MCP tools don't have SKILL.md files).
        const definition: SkillDefinition = {
          ...extSkill,
          body: extSkill.description,
        };
        const result: Result<SkillDefinition, KoiError> = { ok: true, value: definition };
        if (shouldCommit()) {
          cache.set(name, result);
        }
        emitLoaded(name, result, false);
        return result;
      }

      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Skill "${name}" not found. Run discover() first or check that the skill directory exists with a SKILL.md file.`,
          retryable: false,
          context: { name },
        },
      } satisfies Result<SkillDefinition, KoiError>;
    })().finally(() => {
      loadInflight.delete(name);
    });

    loadInflight.set(name, promise);
    return promise;
  };

  // ---------------------------------------------------------------------------
  // loadAll()
  // ---------------------------------------------------------------------------

  const loadAll = async (): Promise<
    Result<ReadonlyMap<string, Result<SkillDefinition, KoiError>>, KoiError>
  > => {
    const discoverResult = await discoverInternal();
    if (!discoverResult.ok) {
      // Discovery failed — surface as outer Result error (Issue 3A)
      return { ok: false, error: discoverResult.error };
    }

    // Collect all skill names from filesystem, external, AND discover-time
    // blocked entries (issue #1722) — loadAll() surfaces the PERMISSION error
    // for blocked skills so callers like createSkillProvider can report them
    // as `skipped`.
    const nameSet = new Set<string>([
      ...(discoveredEntry?.keys() ?? []),
      ...blockedEntry.keys(),
      ...externalSkills.keys(),
    ]);
    const names = Array.from(nameSet);

    // Promise.allSettled — partial failures don't block other skills
    const settled = await Promise.allSettled(names.map((name) => load(name)));

    const resultMap = new Map<string, Result<SkillDefinition, KoiError>>();
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const outcome = settled[i];
      if (name === undefined || outcome === undefined) continue;

      if (outcome.status === "fulfilled") {
        resultMap.set(name, outcome.value);
      } else {
        // Unexpected rejection (shouldn't happen — load() catches all errors)
        resultMap.set(name, {
          ok: false,
          error: {
            code: "INTERNAL",
            message: `Unexpected error loading skill "${name}": ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
            retryable: false,
            context: { name },
          },
        });
      }
    }

    return { ok: true, value: resultMap };
  };

  // ---------------------------------------------------------------------------
  // query()
  // ---------------------------------------------------------------------------

  const query = async (
    filter?: SkillQuery,
  ): Promise<Result<readonly SkillMetadata[], KoiError>> => {
    const discoverResult = await discoverInternal();
    if (!discoverResult.ok) return discoverResult;

    // Linear scan over merged metadata (filesystem + external)
    // Uses the merged map from discover() which already has correct precedence
    let entries = discoveredMetaMap !== undefined ? [...discoveredMetaMap.values()] : [];

    if (filter === undefined) {
      return { ok: true, value: entries };
    }

    if (filter.source !== undefined) {
      const src = filter.source;
      entries = entries.filter((m) => m.source === src);
    }

    if (filter.tags !== undefined && filter.tags.length > 0) {
      // AND semantics: skill must have ALL specified tags (Issue 9A)
      const requiredTags = filter.tags;
      entries = entries.filter((m) => {
        if (m.tags === undefined) return false;
        const skillTags = m.tags;
        return requiredTags.every((tag) => skillTags.includes(tag));
      });
    }

    if (filter.capability !== undefined) {
      const cap = filter.capability;
      entries = entries.filter((m) => m.allowedTools?.includes(cap) ?? false);
    }

    return { ok: true, value: entries };
  };

  // ---------------------------------------------------------------------------
  // invalidate()
  // ---------------------------------------------------------------------------

  const invalidate = (name?: string): void => {
    if (name === undefined) {
      // Full reset: clear filesystem + external + all body caches.
      // Bump the runtime generation so any in-flight discover / rescan
      // whose async work completes after this point detects the mismatch
      // and refuses to repopulate state.
      runtimeGeneration += 1;
      discoveredEntry = undefined;
      discoveredMetaMap = undefined;
      discoverInflight = undefined;
      rescanInflight = undefined;
      blockedEntry = new Map();
      pendingRescan.clear();
      quarantinedUnreadable.clear();
      quarantineBackoff.clear();
      externalSkills = new Map();
      lastExternalRef = externalSkills;
      cache.clear();
      loadInflight.clear();
    } else {
      // Skill-only reset. Clean skills keep the existing contract: the body
      // cache is dropped but the shared discovery map is preserved, so
      // query() for unrelated skills still returns cached metadata without
      // a filesystem re-walk.
      //
      // Blocked skills (issue #1722) need a refresh path: `load()` short-
      // circuits on `blockedEntry` and `discover()` hides the name from the
      // merged map, so a skill that was edited in place to remove dangerous
      // prose would stay blocked forever otherwise. The next `discover()`
      // call will re-read + re-scan just this entry (no full re-walk), so
      // unrelated discovered metadata and blocked-name reservations are
      // untouched. We assign a fresh per-name generation so an in-flight
      // rescan's commit step can detect re-invalidations that raced with
      // its async window.
      // Bump the per-skill generation (review #1896 round 12). Any load()
      // that started before this call and finishes afterward will see the
      // mismatch via shouldCommit() and refuse to write its stale body
      // back into the cache.
      skillGeneration.set(name, getSkillGeneration(name) + 1);
      cache.delete(name);
      loadInflight.delete(name);
      if (blockedEntry.has(name)) {
        nextPendingGen += 1;
        pendingRescan.set(name, nextPendingGen);
        // Reset backoff: an explicit invalidate is the retry trigger, so
        // the next discover() should attempt immediately regardless of
        // any auto-retry cooldown in progress.
        quarantineBackoff.delete(name);
        if (quarantinedUnreadable.has(name)) {
          quarantinedUnreadable.set(name, 0);
        }
      }
    }
  };

  // ---------------------------------------------------------------------------
  // registerExternal()
  // ---------------------------------------------------------------------------

  const registerExternal = (skills: readonly SkillMetadata[]): void => {
    // Bump generation so any in-flight load() whose async work finishes
    // after this call is suppressed from writing a stale entry back into
    // the cache (review #1896 round 11). Matches the guard on the full
    // invalidate() path.
    runtimeGeneration += 1;
    const oldExternal = externalSkills;
    // Full replacement: build a new map from the provided skills.
    const newExternal = new Map(skills.map((s) => [s.name, s]));

    // Evict cached/inflight definitions for names that changed or were removed.
    // Without this, load() returns stale definitions after MCP reconnect.
    for (const [name] of oldExternal) {
      if (!newExternal.has(name) || newExternal.get(name) !== oldExternal.get(name)) {
        cache.delete(name, "external-refresh");
        loadInflight.delete(name);
      }
    }
    // Also evict newly added names in case they shadow a previously-loaded filesystem skill
    for (const [name] of newExternal) {
      if (!oldExternal.has(name)) {
        cache.delete(name, "external-refresh");
        loadInflight.delete(name);
      }
    }

    externalSkills = newExternal;
    // Invalidate the merged meta map so discover() rebuilds it
    discoveredMetaMap = undefined;
  };

  // ---------------------------------------------------------------------------
  // discover() — public wrapper emitting onMetadataInjected (issue #1642)
  // ---------------------------------------------------------------------------

  // Tracks the last Tier 0 map we fired `onMetadataInjected` for, so
  // cached `discover()` calls (fast path: same merged map, no rescan) do
  // not replay the injection hook. Review #1896 round 10: integrators use
  // this callback to inject the full listing into a model turn; a replay
  // on every cached call silently duplicates the listing into prompt
  // context. Identity comparison is enough — `discoverInternal` replaces
  // the map reference whenever the filesystem / external / blocked sets
  // actually change.
  let lastInjectedMapRef: ReadonlyMap<string, SkillMetadata> | undefined;

  const discover = async (): Promise<Result<ReadonlyMap<string, SkillMetadata>, KoiError>> => {
    const result = await discoverInternal();
    if (result.ok && onMetadataInjected !== undefined && result.value !== lastInjectedMapRef) {
      lastInjectedMapRef = result.value;
      onMetadataInjected(result.value.size);
    }
    return result;
  };

  // ---------------------------------------------------------------------------
  // loadReference() — Tier 2 (issue #1642)
  // ---------------------------------------------------------------------------

  /**
   * Uniform denial for any undeclared / revoked / un-discovered Tier 2 read
   * (review #1896 round 7). Returning the declared allowlist in error
   * context would be an enumeration oracle — a caller could probe any
   * invalid path, read the returned list, and then issue valid reads.
   * Keep the error shape identical for every denial reason.
   */
  function deniedReference(skillName: string, refPath: string): Result<string, KoiError> {
    return {
      ok: false,
      error: {
        code: "PERMISSION",
        message: `Reference "${refPath}" is not available for skill "${skillName}".`,
        retryable: false,
        context: { name: skillName, refPath },
      },
    };
  }

  /**
   * Re-reads a skill's SKILL.md frontmatter and returns the current
   * `references:` allowlist. Runs on every Tier 2 call so policy revocation
   * via `invalidate(name)` takes effect immediately (review #1896 round 5).
   *
   * Frontmatter parse errors surface as VALIDATION so the caller sees the
   * same error code an operator would get at discover time — no silent
   * fallback to an empty list.
   */
  async function readDeclaredReferences(
    skillName: string,
    dirPath: string,
  ): Promise<Result<readonly string[], KoiError>> {
    const skillMdPath = join(dirPath, "SKILL.md");
    let content: string;
    try {
      content = await Bun.file(skillMdPath).text();
    } catch (cause: unknown) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Skill "${skillName}" SKILL.md could not be read for reference allowlist check`,
          retryable: false,
          cause,
          context: { skillName, skillMdPath },
        },
      };
    }
    const parsed = parseSkillMd(content, skillMdPath);
    if (!parsed.ok) return parsed;
    const fm = validateFrontmatter(parsed.value.frontmatter, skillMdPath);
    if (!fm.ok) return fm;
    return { ok: true, value: fm.value.references ?? [] };
  }

  const loadReferenceImpl = async (
    name: string,
    refPath: string,
  ): Promise<Result<string, KoiError>> => {
    // Epoch snapshot (review #1896 round 14). A Tier 2 read that starts
    // just before an invalidate(name) / invalidate() / registerExternal()
    // must not return content that policy has since revoked. Capture the
    // generations now; every commit point below re-checks them and fails
    // closed on mismatch, so the documented "immediate revocation"
    // contract holds for in-flight reads too.
    const startRuntimeGen = runtimeGeneration;
    const startSkillGen = getSkillGeneration(name);
    const stillAuthorized = (): boolean =>
      runtimeGeneration === startRuntimeGen && getSkillGeneration(name) === startSkillGen;
    const revoked = (): Result<string, KoiError> => deniedReference(name, refPath);

    // Ensure discovery has run so we can locate the skill's directory.
    // Internal variant — do not re-fire the onMetadataInjected hook from
    // routine Tier 2 reads (review #1896 round 3).
    const discoverResult = await discoverInternal();
    if (!discoverResult.ok) return discoverResult;
    if (!stillAuthorized()) return revoked();

    // Syntactic hygiene first (review #1896 round 9). Malformed inputs
    // like `../x.md` or `/etc/passwd` must surface as VALIDATION /
    // PATH_TRAVERSAL rather than getting masked by the allowlist denial
    // below — otherwise monitoring keyed off traversal errors loses
    // signal. The check is syntactic and reveals no allowlist state, so
    // it does not create an enumeration oracle.
    const hygiene = validateReferencePath(name, refPath);
    if (!hygiene.ok) return hygiene;

    // Prefer the filesystem entry (has the resolved dir). External (MCP)
    // skills have no filesystem body, so Tier 2 references are only valid
    // for filesystem-sourced skills — fail closed.
    const entry = discoveredEntry?.get(name);
    if (entry === undefined) {
      // Blocked-at-discovery names must behave like NOT_FOUND for Tier 2 —
      // we never hand out files inside a skill that was rejected by the
      // security scanner.
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Skill "${name}" not found. Tier 2 references are only available for discovered filesystem skills.`,
          retryable: false,
          context: { name, refPath },
        },
      };
    }

    // Tier 2 allowlist — intersection of two sources (review #1896 rounds 4–7):
    //
    // 1. The discovery-time snapshot (`entry.references`). This is the
    //    upper bound: allowlist *expansions* made after discovery are
    //    ignored until a rediscovery, so new paths go through the normal
    //    discover pipeline (shadowing + security scan at load time)
    //    instead of becoming live the instant SKILL.md is touched.
    //
    // 2. The current on-disk list. Re-read on every call so *revocations*
    //    take effect immediately — an operator who removes a path from
    //    SKILL.md followed by `invalidate(name)` (or even without it)
    //    should lose access right away, without waiting for a full
    //    re-discovery.
    //
    // A path is authorized only if it appears in BOTH sets.
    const snapshot = entry.references;
    if (snapshot === undefined || snapshot.length === 0) {
      // Use a uniform message so failure shape does not distinguish
      // "no declaration ever" from "declaration revoked" from "path not
      // in the list" — every denied read looks identical to the caller.
      return deniedReference(name, refPath);
    }
    if (!snapshot.includes(refPath)) {
      return deniedReference(name, refPath);
    }
    const current = await readDeclaredReferences(name, entry.dirPath);
    if (!current.ok) return current;
    if (!current.value.includes(refPath)) {
      return deniedReference(name, refPath);
    }
    // Post-await re-check: an invalidate() or invalidate(name) between
    // the fresh-read above and the file open below must take effect.
    if (!stillAuthorized()) return revoked();

    const result = await loadReference(name, entry.dirPath, refPath, {
      scanner,
      blockOnSeverity: resolvedConfig.blockOnSeverity,
      skillsRoot: entry.skillsRoot,
      ...(resolvedConfig.onSecurityFinding !== undefined
        ? { onSecurityFinding: resolvedConfig.onSecurityFinding }
        : {}),
    });

    // Final guard before handing the content back. A revoke that happens
    // while we were reading the file must still suppress the result —
    // otherwise we'd hand the caller one last copy after policy was
    // withdrawn. Drop the content and return the uniform denial shape.
    if (!stillAuthorized()) return revoked();
    return result;
  };

  return {
    discover,
    load,
    loadAll,
    query,
    loadReference: loadReferenceImpl,
    invalidate,
    registerExternal,
  };
}
