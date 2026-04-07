/**
 * TrajectoryDocumentStore backed by ATIF format with pluggable persistence.
 * Ported from archive/v1/packages/mm/middleware-ace/src/atif-store.ts.
 */

import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core";
import { mapAtifToRichTrajectory, mapRichTrajectoryToAtif } from "./atif-mapper.js";
import type { AtifAgent, AtifDocument, AtifToolDefinition } from "./atif-types.js";

/** Default size cap for ATIF documents (10MB). */
const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;

export interface AtifDocumentStoreConfig {
  readonly agentName: string;
  readonly agentVersion?: string;
  readonly maxSizeBytes?: number;
}

/** Delegate interface for raw ATIF document persistence. */
export interface AtifDocumentDelegate {
  readonly read: (docId: string) => Promise<AtifDocument | undefined>;
  readonly write: (docId: string, doc: AtifDocument) => Promise<void>;
  readonly list: () => Promise<readonly string[]>;
  readonly delete: (docId: string) => Promise<boolean>;
}

/**
 * Simple per-key async mutex. Serializes operations on the same docId
 * to prevent read-modify-write races in concurrent append calls.
 */
function createDocMutex(): { lock(key: string): Promise<() => void> } {
  const locks = new Map<string, Promise<void>>();

  return {
    async lock(key: string): Promise<() => void> {
      // Wait for any in-flight operation on this key
      const current = locks.get(key) ?? Promise.resolve();

      // let: resolver for the next waiter in the queue
      let release: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.set(key, next);

      await current;
      return () => {
        release();
        // Clean up if no one else is queued
        if (locks.get(key) === next) {
          locks.delete(key);
        }
      };
    },
  };
}

/**
 * Enrich the ATIF agent metadata from step data.
 * First-write-wins: only sets model_name/tool_definitions if not already present.
 * Extracts model name from the first model_call step and tool definitions
 * from step metadata.
 */
function enrichAgentMetadata(agent: AtifAgent, steps: readonly RichTrajectoryStep[]): AtifAgent {
  // Extract model name from first agent-sourced model_call step (skip system events)
  const modelName =
    agent.model_name ??
    steps.find((s) => s.kind === "model_call" && s.source === "agent")?.identifier;

  // Extract tool definitions from step metadata (event-trace stores them in metadata.tools)
  const existingTools = agent.tool_definitions;
  // let: collect tool defs from all steps that carry them
  let toolDefs: readonly AtifToolDefinition[] | undefined = existingTools;
  if (toolDefs === undefined || toolDefs.length === 0) {
    const allTools: AtifToolDefinition[] = [];
    const seen = new Set<string>();
    for (const step of steps) {
      const meta = step.metadata as Record<string, unknown> | undefined;
      const tools = meta?.tools;
      if (Array.isArray(tools)) {
        for (const t of tools as readonly {
          readonly name: string;
          readonly description?: string;
        }[]) {
          if (!seen.has(t.name)) {
            seen.add(t.name);
            allTools.push({
              name: t.name,
              ...(t.description !== undefined ? { description: t.description } : {}),
            });
          }
        }
      }
      // Also check tool_call steps for tool names not yet seen
      // Skip system events (mcp:*, hook:*) — those are lifecycle steps, not real tools
      if (
        step.kind === "tool_call" &&
        !seen.has(step.identifier) &&
        !step.identifier.startsWith("mcp:") &&
        !step.identifier.startsWith("hook:") &&
        !step.identifier.startsWith("middleware:")
      ) {
        seen.add(step.identifier);
        allTools.push({ name: step.identifier });
      }
    }
    if (allTools.length > 0) toolDefs = allTools;
  }

  return {
    ...agent,
    ...(modelName !== undefined && agent.model_name === undefined ? { model_name: modelName } : {}),
    ...(toolDefs !== undefined && (existingTools === undefined || existingTools.length === 0)
      ? { tool_definitions: toolDefs }
      : {}),
  };
}

/** Create a TrajectoryDocumentStore backed by an ATIF document delegate. */
export function createAtifDocumentStore(
  config: AtifDocumentStoreConfig,
  delegate: AtifDocumentDelegate,
): TrajectoryDocumentStore {
  const maxSize = config.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const mutex = createDocMutex();

  function createEmptyDoc(docId: string): AtifDocument {
    return {
      schema_version: "ATIF-v1.6",
      session_id: docId,
      agent: {
        name: config.agentName,
        ...(config.agentVersion !== undefined ? { version: config.agentVersion } : {}),
      },
      steps: [],
    };
  }

  return {
    async append(docId: string, steps: readonly RichTrajectoryStep[]): Promise<void> {
      if (steps.length === 0) return;

      const unlock = await mutex.lock(docId);
      try {
        const existing = await delegate.read(docId);
        const doc = existing ?? createEmptyDoc(docId);

        // Reassign stepIndex to be globally unique across the document.
        // Enforce monotonic timestamps: each step's timestamp is at least
        // max(previous_step_timestamp, current_timestamp). This guarantees
        // monotonicity even when concurrent middleware observers call Date.now()
        // independently (see #1558).
        const baseIndex = doc.steps.length;
        const lastExistingTs =
          doc.steps.length > 0
            ? (() => {
                const lastStep = doc.steps[doc.steps.length - 1];
                if (lastStep === undefined) return 0;
                return typeof lastStep.timestamp === "string"
                  ? new Date(lastStep.timestamp).getTime()
                  : (lastStep.timestamp as number);
              })()
            : 0;
        // let: mutable — tracks the running maximum timestamp for monotonicity
        let prevTs = lastExistingTs;
        const reindexedSteps = steps.map((s, i) => {
          const ts = s.timestamp > prevTs ? s.timestamp : prevTs + 1;
          prevTs = ts;
          return { ...s, stepIndex: baseIndex + i, timestamp: ts };
        });

        const newAtifDoc = mapRichTrajectoryToAtif(reindexedSteps, {
          sessionId: docId,
          agentName: config.agentName,
          ...(config.agentVersion !== undefined ? { agentVersion: config.agentVersion } : {}),
        });

        // Enrich agent metadata from step data (first-write-wins)
        const enrichedAgent = enrichAgentMetadata(doc.agent, steps);

        const merged: AtifDocument = {
          ...doc,
          agent: enrichedAgent,
          steps: [...doc.steps, ...newAtifDoc.steps],
        };

        const serialized = JSON.stringify(merged);
        if (serialized.length > maxSize && merged.steps.length > 1) {
          await delegate.write(docId, pruneToSize(merged, maxSize));
        } else {
          await delegate.write(docId, merged);
        }
      } finally {
        unlock();
      }
    },

    async getDocument(docId: string): Promise<readonly RichTrajectoryStep[]> {
      const doc = await delegate.read(docId);
      if (doc === undefined) return [];
      return mapAtifToRichTrajectory(doc);
    },

    async getStepRange(
      docId: string,
      startIndex: number,
      endIndex: number,
    ): Promise<readonly RichTrajectoryStep[]> {
      const doc = await delegate.read(docId);
      if (doc === undefined) return [];
      return mapAtifToRichTrajectory(doc).filter(
        (step) => step.stepIndex >= startIndex && step.stepIndex < endIndex,
      );
    },

    async getSize(docId: string): Promise<number> {
      const doc = await delegate.read(docId);
      if (doc === undefined) return 0;
      return JSON.stringify(doc).length;
    },

    async prune(olderThanMs: number): Promise<number> {
      const docIds = await delegate.list();
      // let: mutable counter
      let pruned = 0;

      for (const docId of docIds) {
        const doc = await delegate.read(docId);
        if (doc === undefined) continue;

        const lastStep = doc.steps[doc.steps.length - 1];
        if (lastStep === undefined) continue;

        const lastTimestamp = new Date(lastStep.timestamp).getTime();
        if (lastTimestamp < olderThanMs) {
          await delegate.delete(docId);
          pruned += doc.steps.length;
        }
      }

      return pruned;
    },
  };
}

/** Prune oldest steps until document fits within maxSize. */
function pruneToSize(doc: AtifDocument, maxSize: number): AtifDocument {
  const steps = [...doc.steps];
  while (steps.length > 1) {
    steps.shift();
    const candidate: AtifDocument = { ...doc, steps };
    if (JSON.stringify(candidate).length <= maxSize) return candidate;
  }
  return { ...doc, steps };
}
