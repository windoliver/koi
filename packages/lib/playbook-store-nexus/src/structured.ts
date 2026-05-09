import type { StructuredPlaybook, StructuredPlaybookStore } from "@koi/ace-types";

import { deleteJson, encodeAceId, listChildren, readJson, validateAceId } from "./json-io.js";
import { withPlaybookLock } from "./playbook-locks.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

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

export function createNexusStructuredPlaybookStore(
  config: NexusPlaybookStoreConfig,
): StructuredPlaybookStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const dir = `${base}/structured`;
  const transport = config.transport;
  // Derive the effective lock scope — must match the scope used by any
  // createNexusPlaybookProposalStore pointing at the same backend so that
  // save/recordProposal interleaving is serialised across instances.
  const scope = config.lockScope ?? base;
  // Default open so fresh tenants can bootstrap their first structured
  // playbook without a separate pre-provision step. Deployments that run
  // multiple coordinators against the same Nexus namespace and need to
  // close the initial-create race (transport lacks create-only CAS) can
  // opt in by setting requirePreProvisioned: true and pre-provisioning
  // via a single-writer path before any concurrent saves.
  const requirePreProvisioned = config.requirePreProvisioned ?? false;
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
      // Acquire the per-playbook lock shared with recordProposal to serialise
      // in-process save + baseVersion-check interleaving. See playbook-locks.ts.
      await withPlaybookLock(scope, playbook.id, async () => {
        // Enforce monotonic version semantics required by the
        // StructuredPlaybookStore contract (matches sqlite implementation).
        //
        // Cross-process safety: read the current file with metadata, capture
        // its etag, then write back with if_match=etag. The Nexus backend
        // returns CONFLICT (-32006) if the file changed between read and
        // write, so concurrent promotions cannot both succeed at version
        // N+1 — only the writer holding the etag of version N wins.
        const readResult = await transport.call<unknown>("read", {
          path: path(playbook.id),
          return_metadata: true,
        });
        let etag: string | undefined;
        let current: StructuredPlaybook | undefined;
        if (readResult.ok) {
          // Accept both documented envelope shapes: nested
          // `metadata.etag` AND top-level `etag`. Different transport
          // wrappers and backend versions surface the etag at either
          // location; rejecting one shape would brick valid updates.
          const raw = readResult.value as
            | { content?: unknown; metadata?: { etag?: string }; etag?: string }
            | undefined;
          // Fail closed if the path resolved but the content is missing,
          // empty, or not a string — a corrupted/protocol-shifted file must
          // not be silently overwritten and lose the prior head.
          if (raw === undefined) {
            throw new Error(
              `playbook-store-nexus: read returned no envelope at ${path(playbook.id)}`,
            );
          }
          if (typeof raw.content !== "string" || raw.content.length === 0) {
            throw new Error(
              `playbook-store-nexus: read returned empty/non-string content at ${path(playbook.id)} — refusing to overwrite a degraded head`,
            );
          }
          try {
            current = JSON.parse(raw.content) as StructuredPlaybook;
          } catch (e) {
            throw new Error(`playbook-store-nexus: parse error at ${path(playbook.id)}`, {
              cause: e,
            });
          }
          etag = raw.metadata?.etag ?? raw.etag;
        } else if (readResult.error.code !== "NOT_FOUND") {
          throw new Error(readResult.error.message);
        }

        if (current !== undefined) {
          if (playbook.version < current.version) {
            throw new Error(
              `playbook ${playbook.id} cannot save version ${String(playbook.version)} below current version ${String(current.version)}`,
            );
          }
          // Idempotent replay: byte-identical save at the same version is a
          // no-op (caller is confirming an already-applied write under retry
          // semantics). Short-circuit BEFORE the etag check so legitimate
          // retries succeed even on transports with degraded metadata.
          if (
            playbook.version === current.version &&
            canonicalJson(playbook) === canonicalJson(current)
          ) {
            return;
          }
          if (
            playbook.version === current.version &&
            canonicalJson(playbook) !== canonicalJson(current)
          ) {
            throw new Error(
              `playbook ${playbook.id} cannot save divergent content at current version ${String(current.version)}`,
            );
          }
          // Fail closed for real mutations: a successful read of an existing
          // head MUST yield an etag for if_match CAS. Missing etag means the
          // transport's metadata path is degraded — proceeding would silently
          // overwrite blindly.
          if (etag === undefined) {
            throw new Error(
              `playbook-store-nexus: read returned no etag for existing head at ${path(playbook.id)} — refusing blind overwrite`,
            );
          }
        }

        // Refuse to create on first save when fail-closed is enabled.
        // The Nexus transport lacks create-only CAS, so two coordinators
        // racing on the initial write would both succeed (last-writer-wins),
        // silently losing one initial payload. Pre-provisioning eliminates
        // the race by ensuring at most one create ever runs.
        if (current === undefined && requirePreProvisioned) {
          throw new Error(
            `playbook-store-nexus: refusing to create playbook ${playbook.id} on first save (transport lacks create-only CAS). Pre-provision via single-coordinator path, or set requirePreProvisioned: false in deployments where single-writer is guaranteed.`,
          );
        }
        const writeParams: Record<string, unknown> = {
          path: path(playbook.id),
          content: JSON.stringify(playbook),
        };
        if (etag !== undefined) {
          writeParams.if_match = etag;
        }
        const writeResult = await transport.call<unknown>("write", writeParams);
        if (!writeResult.ok) {
          if (writeResult.error.code === "CONFLICT") {
            throw new Error(
              `playbook ${playbook.id} concurrent write conflict at version ${String(current?.version ?? "(initial)")}: ${writeResult.error.message}`,
            );
          }
          throw new Error(writeResult.error.message);
        }
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
