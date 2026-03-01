/**
 * Scope wiring: maps GovernanceScopeConfig + backends to ComponentProviders.
 *
 * Duplicates the pattern from @koi/starter/src/scope-resolver.ts (Rule of Three).
 * Each subsystem: filesystem → browser → credentials → memory.
 */

import type { ComponentProvider, ScopeEnforcer } from "@koi/core";
import { createFileSystemProvider } from "@koi/filesystem";
import type { BrowserScope, NavigationSecurityConfig } from "@koi/scope";
import {
  createAuditedCredentials,
  createEnforcedFileSystem,
  createScopedCredentials,
  createScopedMemoryProvider,
} from "@koi/scope";
import { createBrowserProvider } from "@koi/tool-browser";

import type { GovernanceScopeBackends, GovernanceScopeConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Scope wiring
// ---------------------------------------------------------------------------

/**
 * Wire scope configuration and backends into ComponentProviders.
 *
 * For each subsystem (filesystem, browser, credentials, memory):
 * 1. Check if scope config AND backend are both present
 * 2. Apply enforcer wrapping when provided
 * 3. Apply scoping (local checks: path containment, pattern matching, etc.)
 * 4. Apply audit wrapping when auditSink is available
 * 5. Create the ComponentProvider
 *
 * Missing backends for a configured scope are gracefully skipped.
 */
export function wireGovernanceScope(
  scopeConfig: GovernanceScopeConfig,
  backends: GovernanceScopeBackends,
  enforcer?: ScopeEnforcer,
): readonly ComponentProvider[] {
  const providers: ComponentProvider[] = [];

  // ── Filesystem ──────────────────────────────────────────────────────
  if (scopeConfig.filesystem !== undefined && backends.filesystem !== undefined) {
    const raw = backends.filesystem;
    const enforced = enforcer !== undefined ? createEnforcedFileSystem(raw, enforcer) : raw;

    providers.push(
      createFileSystemProvider({
        backend: enforced,
        scope: {
          root: scopeConfig.filesystem.root,
          mode: scopeConfig.filesystem.mode ?? "rw",
        },
      }),
    );
  }

  // ── Browser ─────────────────────────────────────────────────────────
  if (scopeConfig.browser !== undefined && backends.browser !== undefined) {
    const raw = backends.browser;
    const bc = scopeConfig.browser;

    // Build NavigationSecurityConfig — only include defined properties
    // to satisfy exactOptionalPropertyTypes
    const nav: NavigationSecurityConfig = {
      ...(bc.blockPrivateAddresses !== undefined
        ? { blockPrivateAddresses: bc.blockPrivateAddresses }
        : {}),
      ...(bc.allowedProtocols !== undefined ? { allowedProtocols: bc.allowedProtocols } : {}),
      ...(bc.allowedDomains !== undefined ? { allowedDomains: bc.allowedDomains } : {}),
    };

    const scope: BrowserScope = {
      navigation: nav,
      ...(bc.trustTier !== undefined ? { trustTier: bc.trustTier } : {}),
    };

    providers.push(createBrowserProvider({ backend: raw, scope }));
  }

  // ── Credentials ─────────────────────────────────────────────────────
  if (scopeConfig.credentials !== undefined && backends.credentials !== undefined) {
    const raw = backends.credentials;
    const scoped = createScopedCredentials(raw, {
      keyPattern: scopeConfig.credentials.keyPattern,
    });

    // Optionally wrap with audit
    const audited =
      backends.auditSink !== undefined
        ? createAuditedCredentials(scoped, { sink: backends.auditSink })
        : scoped;

    providers.push({
      name: "governance:credentials",
      attach: async () => new Map([["credentials", audited]]),
    });
  }

  // ── Memory ──────────────────────────────────────────────────────────
  if (scopeConfig.memory !== undefined && backends.memory !== undefined) {
    const raw = backends.memory;

    providers.push(
      createScopedMemoryProvider(raw, {
        namespace: scopeConfig.memory.namespace,
      }),
    );
  }

  return providers;
}
