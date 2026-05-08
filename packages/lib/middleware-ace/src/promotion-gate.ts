/**
 * Pure promotion-gate evaluation and structured playbook operation application.
 */

import type {
  PlaybookBullet,
  PlaybookEvaluation,
  PlaybookProposal,
  PlaybookSection,
  StructuredPlaybook,
  PromotionThresholds,
} from "@koi/ace-types";

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

function findSection(playbook: StructuredPlaybook, sectionName: string): PlaybookSection | undefined {
  const normalized = normalizeSectionKey(sectionName);
  return playbook.sections.find(
    (section) => normalizeSectionKey(section.name) === normalized,
  );
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

function asMetricRecord(metrics: PlaybookEvaluation["metrics"] | null | undefined):
  | Readonly<Record<string, unknown>>
  | undefined {
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
