/**
 * Credentials-scoped wrapper around a `SkillsRuntime` (gov-15).
 *
 * Filters every read path — `discover()`, `load()`, `loadAll()`,
 * `query()`, `loadReference()` — against a `CredentialComponent` so
 * skills whose `requires.credentials.ref` is out of scope are invisible
 * regardless of which surface a caller uses (provider attach, the Skill
 * tool, or direct runtime calls).
 *
 * Why a runtime wrapper instead of provider-level gating: the Skill tool
 * loads bodies via `runtime.load(name)` directly, bypassing the provider's
 * `AttachResult.skipped` filter. Without a runtime-level gate, an agent
 * could call `Skill("cred-blocked")` and receive the body even though
 * provider attach correctly excluded the skill from advertised
 * components. Wrapping the runtime closes that path.
 */

import type { CredentialComponent, KoiError, Result } from "@koi/core";
import { validateCredentialRequires } from "@koi/validation";
import type { SkillDefinition, SkillMetadata, SkillQuery, SkillsRuntime } from "./types.js";

/**
 * Returns a `Result.ok(true)` when the skill is in scope, `Result.ok(false)`
 * when it has a credential requirement that fails. Errors during
 * validation propagate up so silent acceptance never happens.
 */
async function isInScope(
  metadata: SkillMetadata | SkillDefinition,
  credentials: CredentialComponent,
): Promise<Result<boolean, KoiError>> {
  if (metadata.requires?.credentials === undefined) return { ok: true, value: true };
  const result = await validateCredentialRequires(
    {
      credentials: metadata.requires.credentials,
    },
    credentials,
  );
  if (result.ok) return { ok: true, value: true };
  // VALIDATION failure (missing creds) is the gating signal — translate
  // to "not in scope" rather than propagating a hard failure. INTERNAL
  // errors still propagate so transient secret-store outages surface.
  if (result.error.code === "VALIDATION") return { ok: true, value: false };
  return { ok: false, error: result.error };
}

function notFoundError(name: string): KoiError {
  return {
    code: "NOT_FOUND",
    message: `Skill "${name}" is not available (not discovered or out of scope)`,
    retryable: false,
    context: { name },
  };
}

/**
 * Wraps a `SkillsRuntime` so every read path filters skills whose
 * declared `requires.credentials` are not resolvable through the
 * supplied `CredentialComponent`. Out-of-scope skills appear as if they
 * do not exist (least-information principle — agents cannot enumerate
 * other secrets via skill discovery).
 *
 * `invalidate`, `loadReference`, and other write/mutation paths are
 * preserved as-is (with the same scope check on `loadReference` so a
 * blocked skill cannot leak its sidecar files).
 */
export function createScopedSkillsRuntime(
  base: SkillsRuntime,
  credentials: CredentialComponent,
): SkillsRuntime {
  const isAllowed = async (
    metadata: SkillMetadata | SkillDefinition,
  ): Promise<Result<boolean, KoiError>> => isInScope(metadata, credentials);

  return {
    discover: async (): Promise<Result<ReadonlyMap<string, SkillMetadata>, KoiError>> => {
      const result = await base.discover();
      if (!result.ok) return result;
      const filtered = new Map<string, SkillMetadata>();
      for (const [name, metadata] of result.value) {
        const allowed = await isAllowed(metadata);
        if (!allowed.ok) return { ok: false, error: allowed.error };
        if (allowed.value) filtered.set(name, metadata);
      }
      return { ok: true, value: filtered };
    },

    load: async (name: string): Promise<Result<SkillDefinition, KoiError>> => {
      const result = await base.load(name);
      if (!result.ok) return result;
      const allowed = await isAllowed(result.value);
      if (!allowed.ok) return { ok: false, error: allowed.error };
      if (!allowed.value) return { ok: false, error: notFoundError(name) };
      return result;
    },

    loadAll: async (): Promise<
      Result<ReadonlyMap<string, Result<SkillDefinition, KoiError>>, KoiError>
    > => {
      const result = await base.loadAll();
      if (!result.ok) return result;
      const filtered = new Map<string, Result<SkillDefinition, KoiError>>();
      for (const [name, inner] of result.value) {
        if (!inner.ok) {
          filtered.set(name, inner);
          continue;
        }
        const allowed = await isAllowed(inner.value);
        if (!allowed.ok) return { ok: false, error: allowed.error };
        if (!allowed.value) {
          filtered.set(name, { ok: false, error: notFoundError(name) });
          continue;
        }
        filtered.set(name, inner);
      }
      return { ok: true, value: filtered };
    },

    query: async (filter?: SkillQuery): Promise<Result<readonly SkillMetadata[], KoiError>> => {
      const result = await base.query(filter);
      if (!result.ok) return result;
      const filtered: SkillMetadata[] = [];
      for (const metadata of result.value) {
        const allowed = await isAllowed(metadata);
        if (!allowed.ok) return { ok: false, error: allowed.error };
        if (allowed.value) filtered.push(metadata);
      }
      return { ok: true, value: filtered };
    },

    loadReference: async (name: string, refPath: string): Promise<Result<string, KoiError>> => {
      // Block loadReference for out-of-scope skills too — otherwise an
      // agent could exfiltrate sidecar files of a blocked skill (e.g.
      // notes that hint at credentials in scope) without ever loading
      // the SKILL.md body.
      const meta = await base.discover();
      if (!meta.ok) return meta;
      const skillMeta = meta.value.get(name);
      if (skillMeta === undefined) {
        return { ok: false, error: notFoundError(name) };
      }
      const allowed = await isAllowed(skillMeta);
      if (!allowed.ok) return { ok: false, error: allowed.error };
      if (!allowed.value) return { ok: false, error: notFoundError(name) };
      return base.loadReference(name, refPath);
    },

    invalidate: base.invalidate.bind(base),
    registerExternal: base.registerExternal.bind(base),
  };
}
