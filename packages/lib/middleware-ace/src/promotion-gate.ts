/**
 * Pure promotion-gate evaluation and structured playbook operation application.
 */

import type {
  PlaybookBullet,
  PlaybookEvaluation,
  PlaybookProposal,
  PlaybookProposalStore,
  PlaybookSection,
  PromotionThresholds,
  StructuredPlaybook,
  StructuredPlaybookStore,
} from "@koi/ace-types";

export interface PromotionGateDeps {
  readonly structuredStore: StructuredPlaybookStore;
  // Required for any mutating path so every committed head has a durable
  // proposal/evaluation lineage record. evaluatePromotion() is pure and does
  // not need this dep; commit/rollback do, and fail closed when missing.
  readonly proposalStore: PlaybookProposalStore;
  readonly clock?: () => number;
}

export interface PromotionDecision {
  readonly outcome: "promoted" | "rejected" | "rolled_back";
  readonly playbookId: string;
  readonly proposalId: string;
  readonly evaluationId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
}

function slugifySectionName(section: string): string {
  const slug = section
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "section";
}

function normalizeSectionKey(sectionName: string): string {
  return slugifySectionName(sectionName);
}

function nextBulletId(playbook: StructuredPlaybook): string {
  let maxId = 0;
  for (const section of playbook.sections) {
    for (const bullet of section.bullets) {
      const match = /^str-(\d+)$/.exec(bullet.id);
      if (match === null) continue;
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > maxId) {
        maxId = parsed;
      }
    }
  }
  return `str-${String(maxId + 1).padStart(5, "0")}`;
}

function findSection(
  playbook: StructuredPlaybook,
  sectionName: string,
): PlaybookSection | undefined {
  const normalized = normalizeSectionKey(sectionName);
  return playbook.sections.find((section) => normalizeSectionKey(section.name) === normalized);
}

function ensureSection(playbook: StructuredPlaybook, sectionName: string): PlaybookSection {
  const found = findSection(playbook, sectionName);
  if (found !== undefined) return found;

  const created: PlaybookSection = {
    name: sectionName,
    slug: slugifySectionName(sectionName),
    bullets: [],
  };
  (playbook.sections as PlaybookSection[]).push(created);
  return created;
}

function findBulletLocation(
  playbook: StructuredPlaybook,
  bulletId: string,
): { readonly sectionIndex: number; readonly bulletIndex: number } | undefined {
  for (let sectionIndex = 0; sectionIndex < playbook.sections.length; sectionIndex++) {
    const section = playbook.sections[sectionIndex];
    if (section === undefined) continue;
    const bulletIndex = section.bullets.findIndex((bullet) => bullet.id === bulletId);
    if (bulletIndex !== -1) {
      return { sectionIndex, bulletIndex };
    }
  }
  return undefined;
}

function removeBulletAt(
  playbook: StructuredPlaybook,
  sectionIndex: number,
  bulletIndex: number,
): void {
  const section = playbook.sections[sectionIndex];
  if (section === undefined) return;
  (section.bullets as PlaybookBullet[]).splice(bulletIndex, 1);
}

function assertNonEmptyId(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function readNumberMetric(
  metrics: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asMetricRecord(
  metrics: PlaybookEvaluation["metrics"] | null | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (metrics === null || metrics === undefined) return undefined;
  if (typeof metrics !== "object") return undefined;
  return metrics as Readonly<Record<string, unknown>>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function areValidThresholds(thresholds: PromotionThresholds): boolean {
  if (!isFiniteNumber(thresholds.minHelpfulRate)) return false;
  if (!isFiniteNumber(thresholds.maxHarmfulRate)) return false;
  if (!isFiniteNumber(thresholds.minTrials)) return false;
  if (thresholds.maxTokenDelta !== undefined && !isFiniteNumber(thresholds.maxTokenDelta)) {
    return false;
  }
  return true;
}

export function applyProposalOperations(
  playbook: StructuredPlaybook,
  proposal: PlaybookProposal,
  now: number,
): StructuredPlaybook {
  const next = structuredClone(playbook) as StructuredPlaybook;

  for (const operation of proposal.operations) {
    switch (operation.kind) {
      case "add": {
        const section = ensureSection(next, operation.section);
        const bullet: PlaybookBullet = {
          id: nextBulletId(next),
          content: operation.content,
          helpful: 0,
          harmful: 0,
          createdAt: now,
          updatedAt: now,
        };
        (section.bullets as PlaybookBullet[]).push(bullet);
        break;
      }
      case "merge": {
        if (operation.bulletIds[0] === operation.bulletIds[1]) {
          throw new Error("merge operation cannot target the same bullet twice");
        }

        const first = findBulletLocation(next, operation.bulletIds[0]);
        const second = findBulletLocation(next, operation.bulletIds[1]);
        if (first === undefined || second === undefined) {
          throw new Error(
            `merge operation missing bullet ${first === undefined ? operation.bulletIds[0] : operation.bulletIds[1]}`,
          );
        }

        const firstSection = next.sections[first.sectionIndex];
        const secondSection = next.sections[second.sectionIndex];
        if (firstSection === undefined || secondSection === undefined) {
          throw new Error("merge operation missing bullet");
        }

        const firstBullet = firstSection.bullets[first.bulletIndex];
        const secondBullet = secondSection.bullets[second.bulletIndex];
        if (firstBullet === undefined || secondBullet === undefined) {
          throw new Error("merge operation missing bullet");
        }

        (firstSection.bullets as PlaybookBullet[])[first.bulletIndex] = {
          ...firstBullet,
          content: operation.content,
          helpful: firstBullet.helpful + secondBullet.helpful,
          harmful: firstBullet.harmful + secondBullet.harmful,
          updatedAt: now,
        };
        removeBulletAt(next, second.sectionIndex, second.bulletIndex);
        break;
      }
      case "prune": {
        const location = findBulletLocation(next, operation.bulletId);
        if (location === undefined) {
          throw new Error(`prune operation missing bullet ${operation.bulletId}`);
        }
        removeBulletAt(next, location.sectionIndex, location.bulletIndex);
        break;
      }
    }
  }

  return next;
}

export async function evaluatePromotion(
  proposal: PlaybookProposal,
  evaluation: PlaybookEvaluation,
  thresholds: PromotionThresholds,
): Promise<"promote" | "reject" | "rollback"> {
  if (!areValidThresholds(thresholds)) {
    return "reject";
  }

  assertNonEmptyId(proposal.id, "proposal.id");
  assertNonEmptyId(evaluation.id, "evaluation.id");
  assertNonEmptyId(evaluation.proposalId, "evaluation.proposalId");

  if (evaluation.proposalId !== proposal.id) {
    throw new Error("evaluation.proposalId must match proposal.id");
  }

  if (evaluation.verdict === "reject") {
    return "reject";
  }

  if (evaluation.verdict === "rollback") {
    return "rollback";
  }

  if (evaluation.verdict !== "promote") {
    return "reject";
  }

  const metrics = asMetricRecord(evaluation.metrics);
  if (metrics === undefined) {
    return "reject";
  }

  const helpfulRate = readNumberMetric(metrics, "helpfulRate");
  const harmfulRate = readNumberMetric(metrics, "harmfulRate");
  const trials = readNumberMetric(metrics, "trials");

  if (helpfulRate === undefined || harmfulRate === undefined || trials === undefined) {
    return "reject";
  }

  if (helpfulRate < thresholds.minHelpfulRate) {
    return "reject";
  }

  if (harmfulRate > thresholds.maxHarmfulRate) {
    return "reject";
  }

  if (trials < thresholds.minTrials) {
    return "reject";
  }

  if (thresholds.maxTokenDelta !== undefined) {
    const tokenDelta = readNumberMetric(metrics, "tokenDelta");
    if (tokenDelta === undefined || tokenDelta > thresholds.maxTokenDelta) {
      return "reject";
    }
  }

  return "promote";
}

/**
 * Commit a proposal/evaluation pair.
 *
 * Precondition (recommended): durably record the proposal via
 * `proposalStore.recordProposal(proposal)` BEFORE generating its evaluation.
 * The gate also calls recordProposal idempotently as a safety net, but real
 * proposal-store adapters reject FRESH inserts of proposals whose baseVersion
 * no longer matches the live head; if the head advanced before the proposal
 * was first stored, neither the gate nor the caller can recover the audit.
 *
 * Recovery limits: indeterminate-retry resolution (proposal already recorded
 * but the head advanced beyond baseVersion without naming it) requires the
 * structured store to support lineage scan by provenance.proposalId. Adapters
 * without lineage (e.g. nexus) cannot resolve this case automatically; the
 * gate surfaces an explicit error so callers do not silently misclassify.
 */
export async function commitPromotion(
  deps: PromotionGateDeps,
  proposal: PlaybookProposal,
  evaluation: PlaybookEvaluation,
  thresholds: PromotionThresholds,
): Promise<PromotionDecision> {
  // Fail closed on rollback verdict: commitPromotion is the promote/reject
  // dispatch path and must never silently downgrade a rollback decision to a
  // reject. Callers route rollback evaluations through rollbackPromotion()
  // explicitly so the version restore path runs.
  if (evaluation.verdict === "rollback") {
    throw new Error(
      "ACE promotion gate: commitPromotion received a rollback verdict; route rollback evaluations through rollbackPromotion()",
    );
  }

  const current = await deps.structuredStore.get(proposal.playbookId);
  if (current === undefined) {
    throw new Error(`ACE promotion gate: structured playbook not found: ${proposal.playbookId}`);
  }

  const gateDecision = await evaluatePromotion(proposal, evaluation, thresholds);
  if (gateDecision !== "promote") {
    // Reject path is audit-only: do NOT require current.version === baseVersion.
    // If a concurrent promotion advanced the head after this proposal was
    // created, we still want a durable reject evaluation against the existing
    // proposal so the audit log explains every outcome.
    //
    // Real proposal stores reject FRESH inserts whose baseVersion no longer
    // matches the live head (sqlite checks this after the FK insert; nexus
    // checks before). To stay safe under concurrency, only call
    // recordProposal when the proposal is not already persisted — that way an
    // already-stored proposal keeps its existing record and a stale-but-never-
    // recorded proposal surfaces a clear, distinct error instead of silently
    // dropping the reject audit.
    const existing = await deps.proposalStore.getProposal(proposal.id);
    if (existing === undefined) {
      // Fresh recordProposal would be rejected by the store's baseVersion FK
      // check when the head has advanced. Surface a precise precondition
      // error instead of letting the caller see an opaque FK failure.
      if (current.version !== proposal.baseVersion) {
        throw new Error(
          `ACE promotion gate: cannot record reject for proposal ${proposal.id} that was never durably stored once the head advanced (head=${current.version}, baseVersion=${proposal.baseVersion}); pre-record proposals before evaluation`,
        );
      }
      await deps.proposalStore.recordProposal(proposal);
    }
    await deps.proposalStore.recordEvaluation(evaluation);

    return {
      outcome: "rejected",
      playbookId: proposal.playbookId,
      proposalId: proposal.id,
      evaluationId: evaluation.id,
      fromVersion: current.version,
      toVersion: current.version,
    };
  }

  // Idempotent-retry detection: if the current head's provenance already
  // names this proposal+evaluation, a previous call already committed and
  // the caller is retrying after a lost ack. Return the prior success
  // instead of throwing on the version-advanced check below.
  if (
    current.provenance?.proposalId === proposal.id &&
    current.provenance.evaluationId === evaluation.id
  ) {
    return {
      outcome: "promoted",
      playbookId: proposal.playbookId,
      proposalId: proposal.id,
      evaluationId: evaluation.id,
      fromVersion: proposal.baseVersion,
      toVersion: current.version,
    };
  }

  // Indeterminate-retry detection: the proposal/evaluation are already
  // durably recorded but the current head does NOT name them. Two cases
  // produce this state, and we cannot distinguish them without lineage
  // search:
  //   (a) a prior commit succeeded (head advanced to N+1 with our
  //       provenance) and a later commit superseded it (head now N+2).
  //   (b) recordEvaluation succeeded but save() failed; head never moved
  //       past N, then another caller advanced it to N+1.
  // Both leave a recorded evaluation with no live-head match. Surface an
  // explicit error so callers do not misclassify (a) as a fresh failure;
  // resolution requires querying the structured store's lineage table for
  // a version whose provenance.proposalId === proposal.id.
  if (current.version !== proposal.baseVersion) {
    const priorProposal = await deps.proposalStore.getProposal(proposal.id);
    if (priorProposal !== undefined) {
      // Persist the evaluation before surfacing the indeterminate retry
      // error so audit lineage is durable even when the gate cannot
      // commit. recordEvaluation is idempotent on byte-identical retries
      // by the proposal-store contract — safe to call here whether this
      // is case (a) (prior commit succeeded, head later superseded) or
      // case (b) (recordEvaluation already happened in a prior call).
      // Without this, long-running evaluators racing other commits would
      // lose their evaluator output exactly when ambiguity arises.
      await deps.proposalStore.recordEvaluation(evaluation);
      throw new Error(
        `ACE promotion gate: indeterminate retry for proposal ${proposal.id} on ${proposal.playbookId}; proposal already recorded but head advanced beyond baseVersion ${String(proposal.baseVersion)} to ${String(current.version)} without naming it. Inspect structured-store lineage to determine prior commit outcome before retrying`,
      );
    }
    throw new Error(
      `ACE promotion gate: base version mismatch for ${proposal.playbookId}; expected ${proposal.baseVersion}, got ${current.version}`,
    );
  }

  const now = deps.clock?.() ?? Date.now();
  const nextBody = applyProposalOperations(current, proposal, now);
  const next: StructuredPlaybook = {
    ...nextBody,
    updatedAt: now,
    version: current.version + 1,
    // Advance the reflection watermark so a retry / restart cannot
    // re-reflect this trajectory window and re-promote the same evidence.
    // The watermark is monotonic across all commit paths (promote and
    // rollback both bump it) — never regress, never skip ahead.
    lastReflectedStepIndex: maxWatermark(
      current.lastReflectedStepIndex,
      proposal.sourceTrajectoryRange.toStepIndex,
    ),
    provenance: {
      sourceTrajectoryRange: proposal.sourceTrajectoryRange,
      proposalId: proposal.id,
      evaluationId: evaluation.id,
      committedAt: now,
    },
  };

  // Audit-first ordering: persist the proposal AND evaluation BEFORE advancing
  // the head so any visible commit always has a recorded lineage. If save()
  // fails the head stays at baseVersion and a retry is safe — both
  // recordProposal and recordEvaluation are idempotent on byte-identical
  // payloads. Store implementations are responsible for rejecting stale/equal
  // conflicting writes via version monotonicity checks.
  await deps.proposalStore.recordProposal(proposal);
  await deps.proposalStore.recordEvaluation(evaluation);

  await deps.structuredStore.save(next);

  return {
    outcome: "promoted",
    playbookId: proposal.playbookId,
    proposalId: proposal.id,
    evaluationId: evaluation.id,
    fromVersion: current.version,
    toVersion: next.version,
  };
}

/** Monotonic max for the reflection watermark — undefined-safe. */
function maxWatermark(prior: number | undefined, candidate: number): number {
  if (prior === undefined) return candidate;
  return candidate > prior ? candidate : prior;
}

export async function rollbackPromotion(
  deps: PromotionGateDeps,
  proposal: PlaybookProposal,
  targetVersion: number,
  evaluation: PlaybookEvaluation,
): Promise<PromotionDecision> {
  // Lineage capability: getVersion is the documented mandatory hook for
  // historical lookup. The optional lineageSupported flag is an explicit
  // opt-out for stub adapters whose getVersion always returns undefined
  // (e.g. nexus). Treat the flag as a fail-closed signal only when explicitly
  // set to false; absent (undefined) means "trust getVersion presence" so
  // existing/third-party adapters that implement getVersion correctly do not
  // need to be updated to set the new flag.
  if (
    deps.structuredStore.getVersion === undefined ||
    deps.structuredStore.lineageSupported === false
  ) {
    throw new Error("ACE promotion gate: rollback requires structured store lineage support");
  }

  assertNonEmptyId(proposal.id, "proposal.id");
  assertNonEmptyId(evaluation.id, "evaluation.id");
  assertNonEmptyId(evaluation.proposalId, "evaluation.proposalId");

  if (evaluation.proposalId !== proposal.id) {
    throw new Error("evaluation.proposalId must match proposal.id");
  }

  if (evaluation.verdict !== "rollback") {
    throw new Error("ACE promotion gate: rollback evaluation verdict must be rollback");
  }

  const current = await deps.structuredStore.get(proposal.playbookId);
  if (current === undefined) {
    throw new Error(`ACE promotion gate: structured playbook not found: ${proposal.playbookId}`);
  }

  // Idempotent-retry detection: if the current head's provenance already
  // names this proposal+evaluation, a previous rollback already committed
  // and the caller is retrying after a lost ack. Return the prior success.
  if (
    current.provenance?.proposalId === proposal.id &&
    current.provenance.evaluationId === evaluation.id
  ) {
    return {
      outcome: "rolled_back",
      playbookId: proposal.playbookId,
      proposalId: proposal.id,
      evaluationId: evaluation.id,
      fromVersion: proposal.baseVersion,
      toVersion: current.version,
    };
  }

  // Indeterminate-retry detection: see commitPromotion above for rationale.
  // Surface an explicit error when the proposal is already recorded but the
  // live head has advanced past baseVersion without naming it.
  if (current.version !== proposal.baseVersion) {
    const priorProposal = await deps.proposalStore.getProposal(proposal.id);
    if (priorProposal !== undefined) {
      // Same audit-preservation rationale as commitPromotion: record the
      // evaluation before throwing so rollback lineage is durable even
      // under contention. Idempotent by store contract.
      await deps.proposalStore.recordEvaluation(evaluation);
      throw new Error(
        `ACE promotion gate: indeterminate rollback retry for proposal ${proposal.id} on ${proposal.playbookId}; proposal already recorded but head advanced beyond baseVersion ${String(proposal.baseVersion)} to ${String(current.version)} without naming it. Inspect structured-store lineage to determine prior outcome before retrying`,
      );
    }
    throw new Error(
      `ACE promotion gate: base version mismatch for ${proposal.playbookId}; expected ${proposal.baseVersion}, got ${current.version}`,
    );
  }

  if (targetVersion >= current.version) {
    throw new Error(
      "ACE promotion gate: rollback targetVersion must be older than the current head",
    );
  }

  const target = await deps.structuredStore.getVersion(proposal.playbookId, targetVersion);
  if (target === undefined) {
    throw new Error(
      `ACE promotion gate: structured playbook version not found: ${proposal.playbookId}@${targetVersion}`,
    );
  }

  const now = deps.clock?.() ?? Date.now();
  const restored: StructuredPlaybook = {
    ...target,
    version: current.version + 1,
    updatedAt: now,
    // Watermark monotonicity: even on rollback we must not regress the
    // reflection watermark. The current head's watermark dominates
    // because it has already been reflected past; the rollback target
    // body is restored but its old watermark is replaced.
    lastReflectedStepIndex: maxWatermark(
      current.lastReflectedStepIndex,
      proposal.sourceTrajectoryRange.toStepIndex,
    ),
    provenance: {
      sourceTrajectoryRange: proposal.sourceTrajectoryRange,
      proposalId: proposal.id,
      evaluationId: evaluation.id,
      committedAt: now,
    },
  };

  // Audit-first ordering: same rationale as commitPromotion above. Persist
  // the proposal first to satisfy proposal -> evaluation FK / existence
  // requirements in sqlite/nexus adapters; both calls are idempotent on
  // byte-identical retries.
  await deps.proposalStore.recordProposal(proposal);
  await deps.proposalStore.recordEvaluation(evaluation);

  await deps.structuredStore.save(restored);

  return {
    outcome: "rolled_back",
    playbookId: proposal.playbookId,
    proposalId: proposal.id,
    evaluationId: evaluation.id,
    fromVersion: current.version,
    toVersion: restored.version,
  };
}
