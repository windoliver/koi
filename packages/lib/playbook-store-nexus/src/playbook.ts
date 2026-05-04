import type { Playbook, PlaybookStore } from "@koi/ace-types";

import { deleteJson, listChildren, readJson, sanitizeId, writeJson } from "./json-io.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

const DEFAULT_BASE = "ace";

export function createNexusPlaybookStore(config: NexusPlaybookStoreConfig): PlaybookStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const dir = `${base}/playbooks`;
  const transport = config.transport;
  const path = (id: string): string => `${dir}/${sanitizeId(id)}.json`;

  return {
    async get(id: string): Promise<Playbook | undefined> {
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
        if (!r.ok || r.value === undefined) continue;
        const pb = r.value;
        if (options?.minConfidence !== undefined && pb.confidence < options.minConfidence) continue;
        if (
          options?.tags !== undefined &&
          options.tags.length > 0 &&
          !options.tags.some((t) => pb.tags.includes(t))
        ) {
          continue;
        }
        out.push(pb);
      }
      return out;
    },

    async save(playbook: Playbook): Promise<void> {
      const r = await writeJson(transport, path(playbook.id), playbook);
      if (!r.ok) throw new Error(r.error.message);
    },

    async remove(id: string): Promise<boolean> {
      const r = await deleteJson(transport, path(id));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },
  };
}
