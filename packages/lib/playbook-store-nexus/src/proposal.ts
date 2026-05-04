import type { PlaybookEvaluation, PlaybookProposal, PlaybookProposalStore } from "@koi/ace-types";

import {
  basenameNoExt,
  decodeAceId,
  encodeAceId,
  exists,
  listChildren,
  readJson,
  validateAceId,
  writeJson,
} from "./json-io.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

const DEFAULT_BASE = "ace";

/** Canonicalize JSON for byte-identical comparison (sorted keys). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = canonicalJson((value as Record<string, unknown>)[k]);
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

export function createNexusPlaybookProposalStore(
  config: NexusPlaybookStoreConfig,
): PlaybookProposalStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const transport = config.transport;

  const proposalPath = (id: string): string => `${base}/proposals/${encodeAceId(id)}.json`;
  const evaluationPath = (proposalId: string): string =>
    `${base}/evaluations/${encodeAceId(proposalId)}.json`;
  const indexPath = (playbookId: string, proposalId: string): string =>
    `${base}/proposals-by-playbook/${encodeAceId(playbookId)}/${encodeAceId(proposalId)}.json`;
  const indexDir = (playbookId: string): string =>
    `${base}/proposals-by-playbook/${encodeAceId(playbookId)}/*.json`;

  return {
    async recordProposal(proposal: PlaybookProposal): Promise<void> {
      const vId = validateAceId(proposal.id, "Proposal ID");
      if (!vId.ok) throw new Error(vId.error.message);
      const vPb = validateAceId(proposal.playbookId, "Playbook ID");
      if (!vPb.ok) throw new Error(vPb.error.message);

      // Immutable audit record contract: if a proposal with the same id already
      // exists, it must be byte-identical. If it differs, reject the write.
      const pPath = proposalPath(proposal.id);
      const ex = await exists(transport, pPath);
      if (!ex.ok) throw new Error(ex.error.message);
      if (ex.value) {
        const existing = await readJson<PlaybookProposal>(transport, pPath);
        if (!existing.ok) throw new Error(existing.error.message);
        if (existing.value !== undefined) {
          if (canonicalJson(existing.value) !== canonicalJson(proposal)) {
            throw new Error(`Proposal id ${proposal.id} already recorded with different content`);
          }
          // Byte-identical: idempotent success — ensure index exists too
          const iPath = indexPath(proposal.playbookId, proposal.id);
          const ixEx = await exists(transport, iPath);
          if (!ixEx.ok) throw new Error(ixEx.error.message);
          if (!ixEx.value) {
            const ir = await writeJson(transport, iPath, {});
            if (!ir.ok) throw new Error(ir.error.message);
          }
          return;
        }
      }

      // Write proposal payload first (durable evidence), then the index marker.
      // If index write fails, retry up to 3 times with linear backoff.
      const r = await writeJson(transport, pPath, proposal);
      if (!r.ok) throw new Error(r.error.message);

      const iPath = indexPath(proposal.playbookId, proposal.id);
      let lastIndexError: string | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          // linear backoff: 50ms, 100ms
          await new Promise<void>((resolve) => setTimeout(resolve, attempt * 50));
        }
        const ir = await writeJson(transport, iPath, {});
        if (ir.ok) {
          lastIndexError = undefined;
          break;
        }
        lastIndexError = ir.error.message;
      }
      if (lastIndexError !== undefined) {
        throw new Error(`Failed to write proposal index after retries: ${lastIndexError}`);
      }
    },

    async recordEvaluation(evaluation: PlaybookEvaluation): Promise<void> {
      const v = validateAceId(evaluation.proposalId, "Proposal ID");
      if (!v.ok) throw new Error(v.error.message);
      const r = await writeJson(transport, evaluationPath(evaluation.proposalId), evaluation);
      if (!r.ok) throw new Error(r.error.message);
    },

    async getProposal(id: string): Promise<PlaybookProposal | undefined> {
      const v = validateAceId(id, "Proposal ID");
      if (!v.ok) throw new Error(v.error.message);
      const r = await readJson<PlaybookProposal>(transport, proposalPath(id));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },

    async listProposals(playbookId: string): Promise<readonly PlaybookProposal[]> {
      const v = validateAceId(playbookId, "Playbook ID");
      if (!v.ok) throw new Error(v.error.message);
      const lr = await listChildren(transport, indexDir(playbookId));
      if (!lr.ok) throw new Error(lr.error.message);
      const out: PlaybookProposal[] = [];
      for (const p of lr.value) {
        // Decode the filename stem to get the original proposal ID
        const proposalId = decodeAceId(basenameNoExt(p));
        const r = await readJson<PlaybookProposal>(transport, proposalPath(proposalId));
        if (!r.ok || r.value === undefined) continue;
        out.push(r.value);
      }
      return out;
    },
  };
}
