/**
 * Reload classification — declares which config sections are safe to hot-apply
 * and which require a process restart.
 *
 * Fail-closed: any changed path without a classification entry is treated as
 * `restart`. This prevents silently hot-applying a newly added field that hasn't
 * been deliberately classified.
 *
 * Longest-prefix match: a changed path `modelRouter.targets` matches the
 * `modelRouter` entry. Deeper-scoped entries (if any are added later) win over
 * shallower ones.
 *
 * An exhaustiveness test in classification.test.ts ensures every top-level
 * section of DEFAULT_KOI_CONFIG is either in FIELD_CLASSIFICATION or in the
 * explicit UNCLASSIFIED_SECTIONS allowlist — renaming or adding a section
 * without deciding its class fails CI.
 */

export type ReloadClass = "hot" | "restart";

/**
 * Dot-path → class mapping. Prefix match: a path `foo.bar.baz` matches the
 * longest entry that is either equal to the path or a dot-prefix of it.
 *
 * Hot — safe to apply to a running agent:
 * - `logLevel`: only affects future log emissions
 * - `loopDetection`: runtime heuristic recomputed per turn
 * - `modelRouter`: next model call picks up the new routing
 * - `features`: feature flags are checked lazily
 *
 * Restart — affect in-flight semaphores / long-lived connections:
 * - `telemetry`: would need to tear down and re-establish OTLP exporter
 * - `limits`: mid-flight concurrency / budget changes are unsafe
 */
export const FIELD_CLASSIFICATION: Readonly<Record<string, ReloadClass>> = Object.freeze({
  logLevel: "hot",
  loopDetection: "hot",
  modelRouter: "hot",
  features: "hot",
  telemetry: "restart",
  limits: "restart",
} as const satisfies Record<string, ReloadClass>);

/**
 * Top-level sections deliberately left unclassified. They default to `restart`
 * until a future PR opts them in. Must be kept in sync with the exhaustiveness
 * test against DEFAULT_KOI_CONFIG.
 */
export const UNCLASSIFIED_SECTIONS: readonly string[] = Object.freeze(["spawn", "forge"]);

export interface ClassifiedPaths {
  readonly hot: readonly string[];
  readonly restart: readonly string[];
}

export function classifyChangedPaths(paths: readonly string[]): ClassifiedPaths {
  const hot: string[] = [];
  const restart: string[] = [];
  for (const path of paths) {
    if (classifyPath(path) === "hot") {
      hot.push(path);
    } else {
      restart.push(path);
    }
  }
  return { hot, restart };
}

function classifyPath(path: string): ReloadClass {
  // Longest-prefix match: scan all classification keys, pick the longest
  // one that equals `path` or is a dot-prefix of it.
  let bestKey = "";
  let bestClass: ReloadClass = "restart"; // fail-closed default
  for (const key of Object.keys(FIELD_CLASSIFICATION)) {
    if (path === key || path.startsWith(`${key}.`)) {
      if (key.length > bestKey.length) {
        bestKey = key;
        const cls = FIELD_CLASSIFICATION[key];
        if (cls !== undefined) {
          bestClass = cls;
        }
      }
    }
  }
  return bestClass;
}
