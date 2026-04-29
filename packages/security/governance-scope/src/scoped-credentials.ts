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
      if (!matchAny(key, allow)) return undefined;
      return component.get(key);
    },
  };
}
