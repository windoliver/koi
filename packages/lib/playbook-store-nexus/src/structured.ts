import type { StructuredPlaybook, StructuredPlaybookStore } from "@koi/ace-types";

import {
  deleteJson,
  encodeAceId,
  listChildren,
  readJson,
  validateAceId,
  writeJson,
} from "./json-io.js";
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
        // StructuredPlaybookStore contract (matches sqlite implementation):
        // reject below-head replays so concurrent promotions cannot lose
        // updates by silently overwriting a higher version. Idempotent
        // re-save of the exact current head is permitted so retries after
        // a successful write but failed ack do not wedge.
        //
        // CONCURRENCY LIMITATION: The read-then-write below is only atomic
        // within a single process via withPlaybookLock. Two processes
        // sharing the same Nexus backend can still race: both read version
        // N, both write N+1, last write wins. Fully closing this requires
        // server-side conditional writes (If-Match / version CAS) on the
        // Nexus transport, which is not yet exposed by writeJson. Until
        // then, callers that need strict cross-process correctness must
        // either funnel writes through a single process or use the sqlite
        // adapter (which has DB-level transactional CAS).
        const currentRead = await readJson<StructuredPlaybook>(transport, path(playbook.id));
        if (!currentRead.ok) throw new Error(currentRead.error.message);
        const current = currentRead.value;
        if (current !== undefined) {
          if (playbook.version < current.version) {
            throw new Error(
              `playbook ${playbook.id} cannot save version ${String(playbook.version)} below current version ${String(current.version)}`,
            );
          }
          if (
            playbook.version === current.version &&
            canonicalJson(playbook) !== canonicalJson(current)
          ) {
            throw new Error(
              `playbook ${playbook.id} cannot save divergent content at current version ${String(current.version)}`,
            );
          }
        }
        const r = await writeJson(transport, path(playbook.id), playbook);
        if (!r.ok) throw new Error(r.error.message);
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
      return undefined;
    },
  };
}
