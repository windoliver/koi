/**
 * Routing: dispatch key computation, pattern matching, and route resolution.
 * All functions are pure — no side effects.
 */

import type { RouteBinding, RoutingConfig, RoutingContext, ScopingMode } from "./types.js";

// Encode routing field characters that would corrupt the colon-delimited key structure.
// ':' is the segment delimiter; '*' and '**' are wildcard tokens in patterns.
function sanitizeField(value: string): string {
  return value.replace(/[:%*]/g, (c) => `%${c.codePointAt(0)?.toString(16).toUpperCase()}`);
}

export function computeDispatchKey(mode: ScopingMode, routing?: RoutingContext): string {
  if (mode === "main") return "main";

  const peer = sanitizeField(routing?.peer ?? "_");
  if (mode === "per-peer") return peer;

  const channel = sanitizeField(routing?.channel ?? "_");
  if (mode === "per-channel-peer") return `${channel}:${peer}`;

  if (mode === "per-account-channel-peer") {
    const account = sanitizeField(routing?.account ?? "_");
    return `${account}:${channel}:${peer}`;
  }

  const _exhaustive: never = mode;
  throw new Error(`Unknown scoping mode: ${String(_exhaustive)}`);
}

export function validateBindingPattern(pattern: string): string | undefined {
  const segments = pattern.split(":");
  const doubleStarIndex = segments.indexOf("**");
  if (doubleStarIndex !== -1 && doubleStarIndex !== segments.length - 1) {
    return `"**" must be the last segment in pattern "${pattern}", found at position ${doubleStarIndex}`;
  }
  return undefined;
}

interface CompiledBinding {
  readonly segments: readonly string[];
  readonly agentId: string;
}

function compileBindings(bindings: readonly RouteBinding[]): readonly CompiledBinding[] {
  return bindings.map((binding) => {
    const validationError = validateBindingPattern(binding.pattern);
    if (validationError !== undefined) throw new Error(validationError);
    return { segments: binding.pattern.split(":"), agentId: binding.agentId };
  });
}

const compiledCache = new WeakMap<readonly RouteBinding[], readonly CompiledBinding[]>();

function getCompiled(bindings: readonly RouteBinding[]): readonly CompiledBinding[] {
  let compiled = compiledCache.get(bindings);
  if (compiled === undefined) {
    compiled = compileBindings(bindings);
    compiledCache.set(bindings, compiled);
  }
  return compiled;
}

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
    if (p === "**") return true;
    if (i >= key.length) return false;
    if (p !== "*" && p !== key[i]) return false;
  }
  return key.length === pattern.length;
}

export interface ResolvedRoute {
  readonly agentId: string;
  readonly dispatchKey: string;
}

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
