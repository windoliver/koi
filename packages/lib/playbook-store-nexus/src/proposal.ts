import type {
  PlaybookEvaluation,
  PlaybookProposal,
  PlaybookProposalStore,
  StructuredPlaybook,
} from "@koi/ace-types";

import {
  encodeAceId,
  exists,
  listChildren,
  readJson,
  validateAceId,
  writeJson,
} from "./json-io.js";
import { withPlaybookLock } from "./playbook-locks.js";
import { withProposalLock } from "./proposal-locks.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

const DEFAULT_BASE = "ace";

/**
 * Canonical JSON: stringify with deterministically-sorted object keys at every
 * depth. Preserves array order (meaningful: operations, sections, bullets).
 *
 * Matches the recursive-replacer pattern from @koi/playbook-store-sqlite.
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

export function createNexusPlaybookProposalStore(
  config: NexusPlaybookStoreConfig,
): PlaybookProposalStore {
  const base = config.basePath ?? DEFAULT_BASE;
  const transport = config.transport;
  // Derive the effective lock scope. Two stores pointing at the same backend
  // via DIFFERENT transport objects share a pool when they supply the same
  // lockScope. Default: base — safe when each basePath maps to exactly one
  // backend in a given process.
  const scope = config.lockScope ?? base;

  const proposalPath = (id: string): string => `${base}/proposals/${encodeAceId(id)}.json`;
  const evaluationPath = (proposalId: string): string =>
    `${base}/evaluations/${encodeAceId(proposalId)}.json`;
  // Global evaluation-id index: maps evaluation id → { proposalId } pointer.
  // Enforces global uniqueness of evaluation ids across all proposals.
  const evalIdIndexPath = (evalId: string): string =>
    `${base}/evaluations-by-id/${encodeAceId(evalId)}.json`;
  const structuredPath = (playbookId: string): string =>
    `${base}/structured/${encodeAceId(playbookId)}.json`;

  // Per-id in-process mutex via the module-level registry. Shared across all
  // instances with the same lockScope so cross-instance same-process races on
  // the same proposal/evaluation id are also serialised.
  //
  // CONCURRENCY LIMIT: global-uniqueness guarantees hold PER PROCESS only.
  // Cross-process atomic create-if-absent requires Nexus-level CAS (etag /
  // if_match), which @koi/nexus-client does not yet expose. Distributed
  // deployments must funnel all proposal and evaluation writes through a single
  // coordinator process. Tracking issue: #1469.
  function withIdLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
    return withProposalLock(scope, key, fn);
  }

  return {
    async recordProposal(proposal: PlaybookProposal): Promise<void> {
      const vId = validateAceId(proposal.id, "Proposal ID");
      if (!vId.ok) throw new Error(vId.error.message);
      const vPb = validateAceId(proposal.playbookId, "Playbook ID");
      if (!vPb.ok) throw new Error(vPb.error.message);

      return withIdLock(proposal.id, async () => {
        // Idempotency check FIRST: if a proposal with this id already exists,
        // compare content before doing anything else. This allows a successful
        // recordProposal to be safely retried even after the playbook head has
        // advanced (baseVersion would mismatch, but the audit record is already
        // durably stored and byte-identical).
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
            // Byte-identical: idempotent success — skip baseVersion re-check.
            return;
          }
        }

        // New proposal: acquire the per-playbook lock shared with structured.save
        // so the baseVersion read and proposal write are atomic with respect to
        // in-process structured.save calls. Cross-process atomicity still requires
        // Nexus CAS (tracking: #1469). Lock order: idLock (proposal id) first, then
        // playbookLock — consistent with all other call sites (no deadlock).
        await withPlaybookLock(scope, proposal.playbookId, async () => {
          // Existence + version check: structured playbook MUST exist and its version
          // MUST match proposal.baseVersion. Matches sqlite sibling behaviour —
          // proposals against a never-saved playbook are rejected.
          const spb = await readJson<StructuredPlaybook>(
            transport,
            structuredPath(proposal.playbookId),
          );
          if (!spb.ok) throw new Error(spb.error.message);
          if (spb.value === undefined) {
            throw new Error(
              `Cannot record proposal: structured playbook ${proposal.playbookId} does not exist`,
            );
          }
          if (spb.value.version !== proposal.baseVersion) {
            throw new Error(
              `Proposal baseVersion ${proposal.baseVersion} does not match current structured playbook version ${spb.value.version}`,
            );
          }

          // Write proposal payload — it is the source of truth.
          // listProposals enumerates <base>/proposals/*.json and filters by playbookId,
          // so no separate index file is needed.
          const r = await writeJson(transport, pPath, proposal);
          if (!r.ok) throw new Error(r.error.message);
        });
      });
    },

    async recordEvaluation(evaluation: PlaybookEvaluation): Promise<void> {
      const vPid = validateAceId(evaluation.proposalId, "Proposal ID");
      if (!vPid.ok) throw new Error(vPid.error.message);
      const vEid = validateAceId(evaluation.id, "Evaluation ID");
      if (!vEid.ok) throw new Error(vEid.error.message);

      // Lock order: evalId first (global uniqueness key), then proposalId namespace.
      // Consistent ordering prevents deadlock between concurrent recordEvaluation calls.
      //
      // Null-byte separator: validateAceId rejects '\0', so these keys can never
      // collide — even if evaluation.id === "pid-" + evaluation.proposalId, the
      // resulting keys "eval\0<id>" and "evalpid\0<proposalId>" are always distinct.
      // Without the null-byte separator, the old scheme "eval-pid-X" (outer) and
      // "eval-pid-X" (inner) would deadlock when evaluation.id === "pid-" + proposalId.
      return withIdLock(`eval\0${evaluation.id}`, async () => {
        return withIdLock(`evalpid\0${evaluation.proposalId}`, async () => {
          // Require the proposal to exist before recording an evaluation.
          const pPath = proposalPath(evaluation.proposalId);
          const pEx = await exists(transport, pPath);
          if (!pEx.ok) throw new Error(pEx.error.message);
          if (!pEx.value) {
            throw new Error(
              `Cannot record evaluation: proposal ${evaluation.proposalId} not found`,
            );
          }

          // Immutable audit record: if an evaluation already exists for this
          // proposalId, it must be byte-identical. Rejects conflicting verdicts.
          const ePath = evaluationPath(evaluation.proposalId);
          const exEval = await exists(transport, ePath);
          if (!exEval.ok) throw new Error(exEval.error.message);
          if (exEval.value) {
            const existing = await readJson<PlaybookEvaluation>(transport, ePath);
            if (!existing.ok) throw new Error(existing.error.message);
            if (existing.value !== undefined) {
              if (canonicalJson(existing.value) !== canonicalJson(evaluation)) {
                throw new Error(
                  `Evaluation for proposal ${evaluation.proposalId} already recorded with different content`,
                );
              }
              // Byte-identical: idempotent success — skip global id index re-check.
              return;
            }
          }

          // Enforce global evaluation-id uniqueness via an index file.
          // If a different proposal already owns this evalId, reject the write.
          const idxPath = evalIdIndexPath(evaluation.id);
          const exIdx = await readJson<{ proposalId: string }>(transport, idxPath);
          if (!exIdx.ok) throw new Error(exIdx.error.message);
          if (exIdx.value !== undefined && exIdx.value.proposalId !== evaluation.proposalId) {
            throw new Error(
              `Evaluation id ${evaluation.id} already used for proposal ${exIdx.value.proposalId}`,
            );
          }

          // Write index pointer then payload (both within the double lock).
          const ri = await writeJson(transport, idxPath, { proposalId: evaluation.proposalId });
          if (!ri.ok) throw new Error(ri.error.message);
          const r = await writeJson(transport, ePath, evaluation);
          if (!r.ok) throw new Error(r.error.message);
        });
      });
    },

    async getProposal(id: string): Promise<PlaybookProposal | undefined> {
      const v = validateAceId(id, "Proposal ID");
      if (!v.ok) throw new Error(v.error.message);
      const r = await readJson<PlaybookProposal>(transport, proposalPath(id));
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    },

    /**
     * List all proposals for a given playbook.
     *
     * O(total proposals) — enumerates ALL <base>/proposals/*.json and filters
     * by playbookId. Acceptable for ACE: list ops are user-driven, not hot-path.
     * No separate index file is required; proposal files are the source of truth.
     */
    async listProposals(playbookId: string): Promise<readonly PlaybookProposal[]> {
      const v = validateAceId(playbookId, "Playbook ID");
      if (!v.ok) throw new Error(v.error.message);
      const lr = await listChildren(transport, `${base}/proposals/*.json`);
      if (!lr.ok) throw new Error(lr.error.message);
      const out: PlaybookProposal[] = [];
      for (const p of lr.value) {
        const r = await readJson<PlaybookProposal>(transport, p);
        if (!r.ok) {
          // Tolerate NOT_FOUND: file existed at list time but is gone at read time (race).
          if (r.error.code === "NOT_FOUND") continue;
          // All other errors (EXTERNAL, INTERNAL, etc.) indicate a real failure.
          throw new Error(r.error.message);
        }
        // r.value is undefined only when NOT_FOUND, which is handled above via ok:false
        // after Fix 4. This branch is unreachable in normal operation.
        if (r.value === undefined) continue;
        if (r.value.playbookId === playbookId) {
          out.push(r.value);
        }
      }
      return out;
    },
  };
}
