import type { StructuredPlaybook, StructuredPlaybookStore } from "@koi/ace-types";

import { deleteJson, listChildren, readJson, sanitizeId, writeJson } from "./json-io.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

const DEFAULT_BASE = "ace";

export function createNexusStructuredPlaybookStore(
  config: NexusPlaybookStoreConfig,
): StructuredPlaybookStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const dir = `${base}/structured`;
  const transport = config.transport;
  const path = (id: string): string => `${dir}/${sanitizeId(id)}.json`;

  return {
    async get(id: string): Promise<StructuredPlaybook | undefined> {
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
        if (!r.ok || r.value === undefined) continue;
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
      const r = await writeJson(transport, path(playbook.id), playbook);
      if (!r.ok) throw new Error(r.error.message);
    },

    async remove(id: string): Promise<boolean> {
      const r = await deleteJson(transport, path(id));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },

    async getVersion(_id: string, _version: number): Promise<StructuredPlaybook | undefined> {
      return undefined;
    },
  };
}
