/**
 * resolveManifestScope — maps manifest `scope:` config to scoped ComponentProviders.
 *
 * For each subsystem declared in the manifest scope, wraps the matching raw backend
 * with scope + optional enforcement, then creates a ComponentProvider for agent assembly.
 *
 * Composition: raw backend → scoped wrapper (local checks) → enforced wrapper (pluggable policy)
 */

import type {
  BrowserDriver,
  ComponentProvider,
  CredentialComponent,
  FileSystemBackend,
  MemoryComponent,
  ScopeEnforcer,
} from "@koi/core";
import { createFileSystemProvider } from "@koi/filesystem";
import type {
  ManifestBrowserScope,
  ManifestFileSystemScope,
  ManifestScopeConfig,
} from "@koi/manifest";
import type { BrowserScope, FileSystemScope, NavigationSecurityConfig } from "@koi/scope";
import {
  createEnforcedBrowser,
  createEnforcedCredentials,
  createEnforcedFileSystem,
  createEnforcedMemory,
  createScopedCredentialsProvider,
  createScopedMemoryProvider,
} from "@koi/scope";
import { createBrowserProvider } from "@koi/tool-browser";

// ---------------------------------------------------------------------------
// Backend container
// ---------------------------------------------------------------------------

/** Raw backends available for manifest-driven scope auto-wiring. */
export interface ScopeBackends {
  readonly filesystem?: FileSystemBackend;
  readonly browser?: BrowserDriver;
  readonly credentials?: CredentialComponent;
  readonly memory?: MemoryComponent;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapManifestFsScope(config: ManifestFileSystemScope): FileSystemScope {
  return {
    root: config.root,
    mode: config.mode ?? "rw",
  };
}

function mapManifestBrowserScope(config: ManifestBrowserScope): BrowserScope {
  const navigation: NavigationSecurityConfig = {
    ...(config.allowedProtocols !== undefined
      ? { allowedProtocols: [...config.allowedProtocols] }
      : {}),
    ...(config.allowedDomains !== undefined ? { allowedDomains: [...config.allowedDomains] } : {}),
    ...(config.blockPrivateAddresses !== undefined
      ? { blockPrivateAddresses: config.blockPrivateAddresses }
      : {}),
  };
  return {
    navigation,
    ...(config.trustTier !== undefined ? { trustTier: config.trustTier } : {}),
  };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Map manifest scope config + raw backends → scoped ComponentProviders.
 *
 * If an enforcer is provided, each backend is additionally wrapped with
 * enforced access checks after the local scope boundary checks.
 */
export function resolveManifestScope(
  scopeConfig: ManifestScopeConfig,
  backends: ScopeBackends,
  enforcer?: ScopeEnforcer,
): readonly ComponentProvider[] {
  // Build providers immutably — one optional entry per subsystem, then filter out undefineds.
  const fsProvider =
    scopeConfig.filesystem !== undefined && backends.filesystem !== undefined
      ? createFileSystemProvider({
          backend:
            enforcer !== undefined
              ? createEnforcedFileSystem(backends.filesystem, enforcer)
              : backends.filesystem,
          scope: mapManifestFsScope(scopeConfig.filesystem),
        })
      : undefined;

  const browserProvider =
    scopeConfig.browser !== undefined && backends.browser !== undefined
      ? createBrowserProvider({
          backend:
            enforcer !== undefined
              ? createEnforcedBrowser(backends.browser, enforcer)
              : backends.browser,
          scope: mapManifestBrowserScope(scopeConfig.browser),
        })
      : undefined;

  const credentialsProvider =
    scopeConfig.credentials !== undefined && backends.credentials !== undefined
      ? createScopedCredentialsProvider(
          enforcer !== undefined
            ? createEnforcedCredentials(backends.credentials, enforcer)
            : backends.credentials,
          { keyPattern: scopeConfig.credentials.keyPattern },
        )
      : undefined;

  const memoryProvider =
    scopeConfig.memory !== undefined && backends.memory !== undefined
      ? createScopedMemoryProvider(
          enforcer !== undefined
            ? createEnforcedMemory(backends.memory, enforcer)
            : backends.memory,
          { namespace: scopeConfig.memory.namespace },
        )
      : undefined;

  return [fsProvider, browserProvider, credentialsProvider, memoryProvider].filter(
    (p): p is ComponentProvider => p !== undefined,
  );
}
