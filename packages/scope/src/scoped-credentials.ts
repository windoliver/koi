/**
 * Scoped credentials wrapper — filters credential keys by glob pattern.
 *
 * Non-matching keys return undefined as if they don't exist (principle of
 * least information). The glob is compiled to a RegExp once at construction.
 */

import type { Agent, ComponentProvider, CredentialComponent } from "@koi/core";
import { COMPONENT_PRIORITY, CREDENTIALS } from "@koi/core";
import type { CompiledCredentialsScope, CredentialsScope } from "./types.js";

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Convert a simple glob pattern to a RegExp.
 *
 * Supports `*` as a wildcard matching zero or more non-separator characters.
 * All other regex special characters are escaped. Case-sensitive.
 */
export function compileCredentialsScope(scope: CredentialsScope): CompiledCredentialsScope {
  // Escape regex specials except *, then replace * with [^]* (match anything)
  const escaped = scope.keyPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = `^${escaped.replace(/\*/g, "[^]*")}$`;
  return {
    pattern: new RegExp(regexStr),
    originalPattern: scope.keyPattern,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScopedCredentials(
  component: CredentialComponent,
  scope: CredentialsScope,
): CredentialComponent {
  const compiled = compileCredentialsScope(scope);

  return {
    async get(key: string): Promise<string | undefined> {
      if (!compiled.pattern.test(key)) {
        return undefined;
      }
      return component.get(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createScopedCredentialsProvider(
  component: CredentialComponent,
  scope: CredentialsScope,
): ComponentProvider {
  const scoped = createScopedCredentials(component, scope);

  return {
    name: `scoped-credentials:${scope.keyPattern}`,
    priority: COMPONENT_PRIORITY.AGENT_FORGED,

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      return new Map<string, unknown>([[CREDENTIALS as string, scoped]]);
    },
  };
}
