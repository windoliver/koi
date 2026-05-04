import type { PlaybookEvaluation, PlaybookProposal, PlaybookProposalStore } from "@koi/ace-types";

import { basenameNoExt, listChildren, readJson, sanitizeId, writeJson } from "./json-io.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

const DEFAULT_BASE = "ace";

export function createNexusPlaybookProposalStore(
  config: NexusPlaybookStoreConfig,
): PlaybookProposalStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const transport = config.transport;

  const proposalPath = (id: string): string => `${base}/proposals/${sanitizeId(id)}.json`;
  const evaluationPath = (proposalId: string): string =>
    `${base}/evaluations/${sanitizeId(proposalId)}.json`;
  const indexPath = (playbookId: string, proposalId: string): string =>
    `${base}/proposals-by-playbook/${sanitizeId(playbookId)}/${sanitizeId(proposalId)}.json`;
  const indexDir = (playbookId: string): string =>
    `${base}/proposals-by-playbook/${sanitizeId(playbookId)}/*.json`;

  return {
    async recordProposal(proposal: PlaybookProposal): Promise<void> {
      const r = await writeJson(transport, proposalPath(proposal.id), proposal);
      if (!r.ok) throw new Error(r.error.message);
      const ir = await writeJson(transport, indexPath(proposal.playbookId, proposal.id), {});
      if (!ir.ok) throw new Error(ir.error.message);
    },

    async recordEvaluation(evaluation: PlaybookEvaluation): Promise<void> {
      const r = await writeJson(transport, evaluationPath(evaluation.proposalId), evaluation);
      if (!r.ok) throw new Error(r.error.message);
    },

    async getProposal(id: string): Promise<PlaybookProposal | undefined> {
      const r = await readJson<PlaybookProposal>(transport, proposalPath(id));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },

    async listProposals(playbookId: string): Promise<readonly PlaybookProposal[]> {
      const lr = await listChildren(transport, indexDir(playbookId));
      if (!lr.ok) throw new Error(lr.error.message);
      const out: PlaybookProposal[] = [];
      for (const p of lr.value) {
        const proposalId = basenameNoExt(p);
        const r = await readJson<PlaybookProposal>(transport, proposalPath(proposalId));
        if (!r.ok || r.value === undefined) continue;
        out.push(r.value);
      }
      return out;
    },
  };
}
