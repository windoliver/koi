import type { StructuredPlaybook, StructuredPlaybookStore } from "@koi/ace-types";
import { extractReadContent, type NexusTransport } from "@koi/nexus-client";

import { deleteJson, encodeAceId, listChildren, readJson, validateAceId } from "./json-io.js";
import { withPlaybookLock } from "./playbook-locks.js";
import type { NexusStructuredStoreConfig } from "./types.js";

const DEFAULT_BASE = "ace";

/**
 * Canonical JSON: stringify with deterministically-sorted object keys at every
 * depth so semantically-equal objects compare equal regardless of key insertion
 * order. Array order is preserved (meaningful: sections, bullets, operations).
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k];
    }
    return sorted;
  });
}

/**
 * Pre-write guard for monotonic-version semantics. Returns `true` if the
 * caller should short-circuit (idempotent byte-identical replay); throws on
 * version regression, divergent same-version content, or missing etag for an
 * existing head.
 */
function validateVersionGuard(
  playbook: StructuredPlaybook,
  current: StructuredPlaybook | undefined,
  etag: string | undefined,
  p: string,
): boolean {
  if (current === undefined) return false;
  if (playbook.version < current.version) {
    throw new Error(
      `playbook ${playbook.id} cannot save version ${String(playbook.version)} below current version ${String(current.version)}`,
    );
  }
  if (playbook.version === current.version) {
    if (canonicalJson(playbook) === canonicalJson(current)) return true;
    throw new Error(
      `playbook ${playbook.id} cannot save divergent content at current version ${String(current.version)}`,
    );
  }
  if (etag === undefined) {
    throw new Error(
      `playbook-store-nexus: read returned no etag for existing head at ${p} — refusing blind overwrite`,
    );
  }
  return false;
}

async function writeWithCas(
  transport: NexusTransport,
  p: string,
  playbook: StructuredPlaybook,
  etag: string | undefined,
  currentVersion: number | undefined,
): Promise<void> {
  const params: Record<string, unknown> = { path: p, content: JSON.stringify(playbook) };
  if (etag !== undefined) params.if_match = etag;
  const r = await transport.call<unknown>("write", params);
  if (r.ok) return;
  if (r.error.code === "CONFLICT") {
    throw new Error(
      `playbook ${playbook.id} concurrent write conflict at version ${String(currentVersion ?? "(initial)")}: ${r.error.message}`,
    );
  }
  throw new Error(r.error.message);
}

interface CurrentHead {
  readonly current: StructuredPlaybook | undefined;
  readonly etag: string | undefined;
}

/**
 * Read the current head with metadata for an etag-CAS save. Returns undefined
 * `current` when the file does not exist yet. Decodes through
 * `extractReadContent` so any documented Nexus envelope shape (plain string,
 * `{__type__:"bytes",data:base64}`, nested-content wrapper) round-trips. Etag
 * is read from either `metadata.etag` or top-level `etag` (transport
 * wrappers surface it at either location).
 */
async function readCurrentHead(transport: NexusTransport, p: string): Promise<CurrentHead> {
  const readResult = await transport.call<unknown>("read", { path: p, return_metadata: true });
  if (!readResult.ok) {
    if (readResult.error.code === "NOT_FOUND") return { current: undefined, etag: undefined };
    throw new Error(readResult.error.message);
  }
  const raw = readResult.value as
    | { content?: unknown; metadata?: { etag?: string }; etag?: string }
    | undefined;
  if (raw === undefined) {
    throw new Error(`playbook-store-nexus: read returned no envelope at ${p}`);
  }
  const decoded = extractReadContent(raw);
  if (!decoded.ok) {
    throw new Error(
      `playbook-store-nexus: read returned undecodable content at ${p} — refusing to overwrite a degraded head`,
    );
  }
  if (decoded.value.length === 0) {
    throw new Error(
      `playbook-store-nexus: read returned empty content at ${p} — refusing to overwrite a degraded head`,
    );
  }
  let current: StructuredPlaybook;
  try {
    current = JSON.parse(decoded.value) as StructuredPlaybook;
  } catch (e) {
    throw new Error(`playbook-store-nexus: parse error at ${p}`, { cause: e });
  }
  return { current, etag: raw.metadata?.etag ?? raw.etag };
}

export function createNexusStructuredPlaybookStore(
  config: NexusStructuredStoreConfig,
): StructuredPlaybookStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const dir = `${base}/structured`;
  const transport = config.transport;
  // Derive the effective lock scope — must match the scope used by any
  // createNexusPlaybookProposalStore pointing at the same backend so that
  // save/recordProposal interleaving is serialised across instances.
  const scope = config.lockScope ?? base;
  // No default: requirePreProvisioned is a required field on the config.
  // Forcing the caller to choose ensures every deployment makes an explicit
  // decision about initial-create safety. (This transport lacks create-only
  // CAS; two racing initial saves can both succeed and silently lose one.)
  const requirePreProvisioned = config.requirePreProvisioned;
  const path = (id: string): string => `${dir}/${encodeAceId(id)}.json`;

  return {
    async get(id: string): Promise<StructuredPlaybook | undefined> {
      const v = validateAceId(id, "Structured Playbook ID");
      if (!v.ok) throw new Error(v.error.message);
      const r = await readJson<StructuredPlaybook>(transport, path(id));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },

    async list(options): Promise<readonly StructuredPlaybook[]> {
      const lr = await listChildren(transport, `${dir}/*.json`);
      if (!lr.ok) throw new Error(lr.error.message);
      const out: StructuredPlaybook[] = [];
      for (const p of lr.value) {
        const r = await readJson<StructuredPlaybook>(transport, p);
        if (!r.ok) {
          // Tolerate NOT_FOUND: file vanished between list and read (race).
          if (r.error.code === "NOT_FOUND") continue;
          // All other errors (EXTERNAL, INTERNAL, etc.) indicate a real failure.
          throw new Error(r.error.message);
        }
        if (r.value === undefined) continue;
        const spb = r.value;
        if (
          options?.tags !== undefined &&
          options.tags.length > 0 &&
          !options.tags.every((t) => spb.tags.includes(t))
        ) {
          continue;
        }
        out.push(spb);
      }
      return out;
    },

    async save(playbook: StructuredPlaybook): Promise<void> {
      const v = validateAceId(playbook.id, "Structured Playbook ID");
      if (!v.ok) throw new Error(v.error.message);
      await withPlaybookLock(scope, playbook.id, async () => {
        const { current, etag } = await readCurrentHead(transport, path(playbook.id));
        if (validateVersionGuard(playbook, current, etag, path(playbook.id))) return;
        if (current === undefined && requirePreProvisioned) {
          throw new Error(
            `playbook-store-nexus: refusing to create playbook ${playbook.id} on first save (transport lacks create-only CAS). Pre-provision via single-coordinator path, or set requirePreProvisioned: false in deployments where single-writer is guaranteed.`,
          );
        }
        await writeWithCas(transport, path(playbook.id), playbook, etag, current?.version);
      });
    },

    async remove(id: string): Promise<boolean> {
      const v = validateAceId(id, "Structured Playbook ID");
      if (!v.ok) throw new Error(v.error.message);
      // Also hold the per-playbook lock for remove so a concurrent recordProposal
      // cannot see the playbook disappear mid-check.
      return withPlaybookLock(scope, id, async () => {
        const r = await deleteJson(transport, path(id));
        if (!r.ok) throw new Error(r.error.message);
        return r.value;
      });
    },

    async getVersion(_id: string, _version: number): Promise<StructuredPlaybook | undefined> {
      // No version lineage in this adapter: each save overwrites a single
      // head file. Per the StructuredPlaybookStore contract, return undefined
      // for unsupported lineage so callers that feature-detect via
      // `await store.getVersion?.(...)` take the no-lineage path. Lineage-
      // dependent features (rollback, indeterminate-retry resolution) will
      // surface adapter-level errors when they actually need a historical
      // version that does not exist.
      return undefined;
    },
    // Explicit fail-closed signal: this adapter has no lineage table.
    // Consumers (e.g. promotion-gate rollback) check this to refuse before
    // attempting historical lookups that will silently return undefined.
    lineageSupported: false,
  };
}
