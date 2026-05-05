import type { Playbook, PlaybookStore } from "@koi/ace-types";

import {
  basenameNoExt,
  decodeAceId,
  deleteJson,
  encodeAceId,
  listChildren,
  readJson,
  validateAceId,
  writeJson,
} from "./json-io.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

const DEFAULT_BASE = "ace";

export function createNexusPlaybookStore(config: NexusPlaybookStoreConfig): PlaybookStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const dir = `${base}/playbooks`;
  const transport = config.transport;
  const path = (id: string): string => `${dir}/${encodeAceId(id)}.json`;

  return {
    async get(id: string): Promise<Playbook | undefined> {
      const v = validateAceId(id, "Playbook ID");
      if (!v.ok) throw new Error(v.error.message);
      const r = await readJson<Playbook>(transport, path(id));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },

    async list(options): Promise<readonly Playbook[]> {
      const lr = await listChildren(transport, `${dir}/*.json`);
      if (!lr.ok) throw new Error(lr.error.message);
      const out: Playbook[] = [];
      for (const p of lr.value) {
        const r = await readJson<Playbook>(transport, p);
        if (!r.ok) {
          // Tolerate NOT_FOUND: file vanished between list and read (race).
          if (r.error.code === "NOT_FOUND") continue;
          // All other errors (EXTERNAL, INTERNAL, etc.) indicate a real failure.
          throw new Error(r.error.message);
        }
        if (r.value === undefined) continue;
        const pb = r.value;
        if (options?.minConfidence !== undefined && pb.confidence < options.minConfidence) continue;
        if (
          options?.tags !== undefined &&
          options.tags.length > 0 &&
          !options.tags.every((t) => pb.tags.includes(t))
        ) {
          continue;
        }
        out.push(pb);
      }
      return out;
    },

    async save(playbook: Playbook): Promise<void> {
      const v = validateAceId(playbook.id, "Playbook ID");
      if (!v.ok) throw new Error(v.error.message);
      const r = await writeJson(transport, path(playbook.id), playbook);
      if (!r.ok) throw new Error(r.error.message);
    },

    async remove(id: string): Promise<boolean> {
      const v = validateAceId(id, "Playbook ID");
      if (!v.ok) throw new Error(v.error.message);
      const r = await deleteJson(transport, path(id));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },
  };
}

// Re-export for callers that need to decode a listed path back to an id
export { basenameNoExt, decodeAceId };
