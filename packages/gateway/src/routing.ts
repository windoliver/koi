/**
 * Routing: dispatch key computation, pattern matching, and route resolution.
 * All functions are pure — no side effects.
 */

import type { RouteBinding, RoutingConfig, RoutingContext, ScopingMode } from "./types.js";

// ---------------------------------------------------------------------------
// Dispatch key
// ---------------------------------------------------------------------------

/**
 * Compute a dispatch key from a scoping mode and routing context.
 * Missing segments default to `"_"`.
 */
export function computeDispatchKey(mode: ScopingMode, routing?: RoutingContext): string {
  if (mode === "main") return "main";

  const peer = routing?.peer ?? "_";
  if (mode === "per-peer") return peer;

  const channel = routing?.channel ?? "_";
  if (mode === "per-channel-peer") return `${channel}:${peer}`;

  if (mode === "per-account-channel-peer") {
    const account = routing?.account ?? "_";
    return `${account}:${channel}:${peer}`;
  }

  // Exhaustive check — TypeScript errors if a new ScopingMode is added
  const _exhaustive: never = mode;
  throw new Error(`Unknown scoping mode: ${String(_exhaustive)}`);
}

// ---------------------------------------------------------------------------
// Pattern validation
// ---------------------------------------------------------------------------

/**
 * Validate a binding pattern. Returns an error message if invalid, undefined if ok.
 * Rules: `**` may only appear as the last segment.
 */
export function validateBindingPattern(pattern: string): string | undefined {
  const segments = pattern.split(":");
  const doubleStarIndex = segments.indexOf("**");
  if (doubleStarIndex !== -1 && doubleStarIndex !== segments.length - 1) {
    return `"**" must be the last segment in pattern "${pattern}", found at position ${doubleStarIndex}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Binding resolution
// ---------------------------------------------------------------------------

/**
 * Pre-split binding patterns for hot-path matching.
 * Validates all patterns up front and caches segment arrays.
 */
interface CompiledBinding {
  readonly segments: readonly string[];
  readonly agentId: string;
}

function compileBindings(bindings: readonly RouteBinding[]): readonly CompiledBinding[] {
  return bindings.map((binding) => {
    const validationError = validateBindingPattern(binding.pattern);
    if (validationError !== undefined) {
      throw new Error(validationError);
    }
    return { segments: binding.pattern.split(":"), agentId: binding.agentId };
  });
}

// WeakMap cache: avoids re-compiling the same bindings array on every frame
const compiledCache = new WeakMap<readonly RouteBinding[], readonly CompiledBinding[]>();

function getCompiled(bindings: readonly RouteBinding[]): readonly CompiledBinding[] {
  let compiled = compiledCache.get(bindings);
  if (compiled === undefined) {
    compiled = compileBindings(bindings);
    compiledCache.set(bindings, compiled);
  }
  return compiled;
}

/**
 * Match a dispatch key against a list of route bindings.
 * Patterns are split by `":"` and compared segment-by-segment:
 * - `"*"` matches any single segment
 * - `"**"` at the end matches all remaining segments
 * First match wins. Returns the matched `agentId` or `undefined`.
 *
 * Throws if a pattern has `**` in a non-terminal position.
 */
export function resolveBinding(
  dispatchKey: string,
  bindings: readonly RouteBinding[],
): string | undefined {
  const compiled = getCompiled(bindings);
  const keySegments = dispatchKey.split(":");

  for (const binding of compiled) {
    if (matchSegments(keySegments, binding.segments)) {
      return binding.agentId;
    }
  }

  return undefined;
}

function matchSegments(key: readonly string[], pattern: readonly string[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i] as string;

    if (p === "**") {
      // ** at end matches everything remaining (validated to be terminal)
      return true;
    }

    if (i >= key.length) {
      // Pattern is longer than key
      return false;
    }

    if (p !== "*" && p !== key[i]) {
      return false;
    }
  }

  // All pattern segments consumed — key must also be fully consumed
  return key.length === pattern.length;
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------

export interface ResolvedRoute {
  readonly agentId: string;
  readonly dispatchKey: string;
}

/**
 * Resolve the target agent for a routing context.
 * - If no routing config is provided, returns the fallback immediately (backward compat).
 * - Otherwise, computes the dispatch key, matches bindings, and falls back to `fallbackAgentId`.
 */
export function resolveRoute(
  config: RoutingConfig | undefined,
  routing: RoutingContext | undefined,
  fallbackAgentId: string,
): ResolvedRoute {
  if (config === undefined) {
    return { agentId: fallbackAgentId, dispatchKey: "main" };
  }

  const dispatchKey = computeDispatchKey(config.scopingMode, routing);

  if (config.bindings !== undefined && config.bindings.length > 0) {
    const matched = resolveBinding(dispatchKey, config.bindings);
    if (matched !== undefined) {
      return { agentId: matched, dispatchKey };
    }
  }

  return { agentId: fallbackAgentId, dispatchKey };
}
