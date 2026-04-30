/**
 * Env-var-backed CredentialComponent producer.
 *
 * Resolves keys via process.env using a configurable prefix (default
 * `KOI_CRED_`). Lookup is case-insensitive on the canonical key — the
 * key is uppercased and any non-alphanumeric character becomes `_`
 * before the prefix is applied.
 *
 * Example: with default prefix, `get("openai.api_key")` reads
 * `process.env.KOI_CRED_OPENAI_API_KEY`.
 *
 * Compose with `createScopedCredentials` from `@koi/governance-scope`
 * to attenuate which keys agents/bricks may resolve.
 */

import type { Agent, AttachResult, ComponentProvider, CredentialComponent } from "@koi/core";
import { CREDENTIALS } from "@koi/core";

export interface EnvCredentialsOptions {
  /** Prefix prepended to the canonicalised env-var name. Default: "KOI_CRED_". */
  readonly prefix?: string;
  /** Override env source (mainly for tests). Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

const DEFAULT_PREFIX = "KOI_CRED_";

function canonicalEnvName(key: string, prefix: string): string {
  const upper = key.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `${prefix}${upper}`;
}

export function createEnvCredentials(opts: EnvCredentialsOptions = {}): CredentialComponent {
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const env = opts.env ?? process.env;
  return {
    async get(key: string): Promise<string | undefined> {
      const name = canonicalEnvName(key, prefix);
      const value = env[name];
      if (value === undefined || value === "") return undefined;
      return value;
    },
  };
}

/**
 * Wraps a `CredentialComponent` as a `ComponentProvider` that registers
 * the instance under the `CREDENTIALS` subsystem token. Each agent gets
 * the same component; callers that want per-agent narrowing should pass
 * an already-scoped component (e.g. via `createScopedCredentials`).
 */
export function createCredentialsProvider(component: CredentialComponent): ComponentProvider {
  return {
    name: "credentials",
    async attach(_agent: Agent): Promise<AttachResult> {
      const components = new Map<string, unknown>([[CREDENTIALS as unknown as string, component]]);
      return { components, skipped: [] };
    },
  };
}
