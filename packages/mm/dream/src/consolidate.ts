/**
 * Dream consolidation — merges similar memories, prunes cold ones.
 *
 * Algorithm:
 * 1. List all memories
 * 2. Score each by exponential decay (salience)
 * 3. Group similar memories (by Jaccard threshold)
 * 4. For each cluster with >1 member: LLM merge into single richer memory
 * 5. Prune memories below salience threshold
 * 6. Write merged results, delete originals
 */

import type { MemoryRecord, MemoryType } from "@koi/core";
import { defaultSimilarity } from "./similarity.js";
import type { DreamConfig, DreamResult } from "./types.js";
import { DREAM_DEFAULTS } from "./types.js";

// ---------------------------------------------------------------------------
// Salience scoring (inline — same formula as @koi/memory, avoiding L2 peer dep)
// ---------------------------------------------------------------------------

const LN2 = Math.LN2;
const MS_PER_DAY = 86_400_000;
const DEFAULT_HALF_LIFE_DAYS = 30;

function computeDecayScore(updatedAt: number, now: number): number {
  const ageDays = Math.max(0, (now - updatedAt) / MS_PER_DAY);
  const lambda = LN2 / DEFAULT_HALF_LIFE_DAYS;
  return Math.exp(-lambda * ageDays);
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

interface MemoryCluster {
  readonly members: readonly MemoryRecord[];
}

/**
 * Groups memories by pairwise similarity using complete-linkage:
 * a memory joins a cluster only if it is similar to ALL existing members.
 * This prevents bridge items from chaining unrelated memories together.
 */
function clusterBySimilarity(
  memories: readonly MemoryRecord[],
  threshold: number,
  similarity: (a: string, b: string) => number,
): readonly MemoryCluster[] {
  const clusters: Array<{ members: MemoryRecord[] }> = [];

  for (const memory of memories) {
    // let justified: search for existing cluster to join (complete-linkage)
    let joined = false;
    for (const cluster of clusters) {
      // Complete-linkage: must be similar to ALL members, not just one
      const allSimilar = cluster.members.every(
        (member) => similarity(memory.content, member.content) >= threshold,
      );
      if (allSimilar) {
        cluster.members.push(memory);
        joined = true;
        break;
      }
    }

    if (!joined) {
      clusters.push({ members: [memory] });
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// LLM merge prompt
// ---------------------------------------------------------------------------

function createMergePrompt(memories: readonly MemoryRecord[]): string {
  const entries = memories
    .map((m, i) => `Memory ${i + 1} (type: ${m.type}):\n${m.content}`)
    .join("\n\n---\n\n");

  return `You are consolidating related memories into a single, richer memory entry.

Merge the following memories into ONE consolidated entry that preserves all important information.
Keep the same memory type. Be concise but comprehensive.

Output ONLY a JSON object: { "name": "...", "description": "...", "type": "...", "content": "..." }

Memories to merge:
${entries}`;
}

interface MergeResult {
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly content: string;
}

function parseMergeResponse(response: string): MergeResult | undefined {
  try {
    const objMatch = response.match(/\{[\s\S]*\}/);
    if (objMatch === null) return undefined;

    const parsed: unknown = JSON.parse(objMatch[0]);
    if (parsed === null || typeof parsed !== "object") return undefined;

    const obj = parsed as Record<string, unknown>;
    const name = typeof obj["name"] === "string" ? obj["name"].trim() : "";
    const description = typeof obj["description"] === "string" ? obj["description"].trim() : "";
    const type = typeof obj["type"] === "string" ? obj["type"].trim() : "";
    const content = typeof obj["content"] === "string" ? obj["content"].trim() : "";

    if (name.length === 0 || content.length === 0) return undefined;

    const validTypes = new Set<string>(["user", "feedback", "project", "reference"]);
    if (!validTypes.has(type)) return undefined;

    return { name, description, type: type as MemoryType, content };
  } catch (_e: unknown) {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main consolidation
// ---------------------------------------------------------------------------

/**
 * Runs dream consolidation: merge similar memories, prune cold ones.
 *
 * This is a standalone async function — no middleware coupling.
 * Call from a scheduler, daemon, or CLI command.
 */
export async function runDreamConsolidation(config: DreamConfig): Promise<DreamResult> {
  const startTime = config.now ?? Date.now();
  const similarity = config.similarity ?? defaultSimilarity;
  const mergeThreshold = config.mergeThreshold ?? DREAM_DEFAULTS.mergeThreshold;
  const pruneThreshold = config.pruneThreshold ?? DREAM_DEFAULTS.pruneThreshold;
  const maxTokens = config.maxConsolidationTokens ?? DREAM_DEFAULTS.maxConsolidationTokens;

  // Step 1: List all memories
  const memories = await config.listMemories();
  if (memories.length === 0) {
    return { merged: 0, pruned: 0, unchanged: memories.length, durationMs: 0 };
  }

  // Step 2: Score and partition into prune candidates vs. active
  const active: MemoryRecord[] = [];
  const toPrune: MemoryRecord[] = [];

  for (const memory of memories) {
    const salience = computeDecayScore(memory.updatedAt, startTime);
    if (salience < pruneThreshold) {
      toPrune.push(memory);
    } else {
      active.push(memory);
    }
  }

  // Step 3: Partition by type, then cluster within each type.
  // This prevents mixed-type merges (e.g., private "user" merged with "feedback"),
  // which would break trust boundaries.
  const byType = new Map<string, MemoryRecord[]>();
  for (const memory of active) {
    const group = byType.get(memory.type) ?? [];
    group.push(memory);
    byType.set(memory.type, group);
  }

  const clusters: readonly MemoryCluster[] = [...byType.values()].flatMap((group) =>
    clusterBySimilarity(group, mergeThreshold, similarity),
  );

  // Step 4: Merge multi-member clusters via LLM
  // let justified: mutable counter for merged cluster count
  let mergedCount = 0;
  // let justified: mutable counter for unchanged memories
  let unchangedCount = 0;

  for (const cluster of clusters) {
    if (cluster.members.length <= 1) {
      unchangedCount += cluster.members.length;
      continue;
    }

    try {
      const prompt = createMergePrompt(cluster.members);
      const response = await config.modelCall({
        messages: [
          {
            content: [{ kind: "text", text: prompt }],
            senderId: "system:dream",
            timestamp: startTime,
          },
        ],
        ...(config.consolidationModel !== undefined ? { model: config.consolidationModel } : {}),
        maxTokens,
      });

      const mergeResult = parseMergeResponse(response.content);
      if (mergeResult === undefined) {
        // Failed to parse — leave cluster unchanged
        unchangedCount += cluster.members.length;
        continue;
      }

      // Enforce type safety: the merged type MUST match the cluster's original type.
      // Clusters are already partitioned by type, so all members share the same type.
      // This prevents LLM hallucination from reclassifying memories across trust boundaries.
      const clusterType = cluster.members[0]?.type;
      if (clusterType === undefined || mergeResult.type !== clusterType) {
        unchangedCount += cluster.members.length;
        continue;
      }

      // Write-ahead: create merged record FIRST, then delete originals.
      // If write fails, nothing is lost — originals survive intact.
      // If some deletes fail after write, we have temporary duplicates
      // (safe: next consolidation run will re-cluster and merge them).
      await config.writeMemory({
        name: mergeResult.name,
        description: mergeResult.description,
        type: clusterType,
        content: mergeResult.content,
      });

      // Best-effort delete of originals — duplicates are safe, data loss is not.
      for (const member of cluster.members) {
        try {
          await config.deleteMemory(member.id);
        } catch (_e: unknown) {
          // Swallow — surviving originals will be re-merged on next run
        }
      }

      mergedCount += 1;
    } catch (_e: unknown) {
      // On LLM failure, leave cluster unchanged
      unchangedCount += cluster.members.length;
    }
  }

  // Step 5: Prune cold memories
  // let justified: mutable counter for actual prune successes
  let prunedCount = 0;
  for (const memory of toPrune) {
    try {
      await config.deleteMemory(memory.id);
      prunedCount += 1;
    } catch (_e: unknown) {
      // Best-effort pruning
    }
  }

  const endTime = config.now !== undefined ? config.now : Date.now();
  return {
    merged: mergedCount,
    pruned: prunedCount,
    unchanged: unchangedCount,
    durationMs: endTime - startTime,
  };
}
