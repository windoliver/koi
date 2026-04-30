/**
 * Scoped credentials wrapper — narrows a CredentialComponent to a glob
 * allowlist. Keys that do not match any allowed glob return `undefined`
 * as if the credential does not exist (least-information principle —
 * the tool cannot enumerate other keys).
 */

import type { CredentialComponent } from "@koi/core";
import { compileGlobs, matchAny } from "./glob.js";

export interface ScopedCredentialsOptions {
  readonly allow: readonly string[];
}

export function createScopedCredentials(
  component: CredentialComponent,
  opts: ScopedCredentialsOptions,
): CredentialComponent {
  const allow = compileGlobs(opts.allow);
  return {
    async get(key: string): Promise<string | undefined> {
      // gov-15 round-5: minimal latency-oracle defense. Without this,
      // out-of-scope keys returned synchronously while in-scope-but-
      // missing keys awaited the underlying component — an agent could
      // probe credKey candidates via authed_fetch and distinguish the
      // two by response time. A `Promise.resolve()` await ensures both
      // paths cross the same microtask boundary so dispatch timing
      // doesn't leak allowlist membership.
      //
      // Calling component.get even on the deny path was rejected: that
      // would leak underlying-backend membership (which env vars are
      // set, which secrets exist in Vault) — a strictly worse leak than
      // the original allowlist-membership oracle. The microtask path
      // is sound for any backend whose own miss latency is bounded;
      // operators with adversarial-grade timing requirements should
      // pair this with a backend that exposes a constant-time miss.
      if (!matchAny(key, allow)) {
        await Promise.resolve();
        return undefined;
      }
      return component.get(key);
    },
  };
}
