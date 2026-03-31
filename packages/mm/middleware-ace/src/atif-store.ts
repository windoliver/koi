/**
 * ATIF document store — TrajectoryDocumentStore backed by ATIF format.
 *
 * Stores rich trajectory data as ATIF documents, converting between
 * Koi's RichTrajectoryStep and ATIF v1.6 on the fly. Supports both
 * in-memory (testing) and delegate-backed (Nexus/SQLite) persistence.
 */

import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core/rich-trajectory";
import type { AtifDocument } from "./atif.js";
import { mapAtifToRichTrajectory, mapRichTrajectoryToAtif } from "./atif.js";

/** Default size cap for ATIF documents (10MB). */
const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;

export interface AtifDocumentStoreConfig {
  /** Agent name for ATIF document metadata. */
  readonly agentName: string;
  /** Agent version for ATIF document metadata. */
  readonly agentVersion?: string;
  /** Maximum document size in bytes before pruning. Default: 10MB. */
  readonly maxSizeBytes?: number;
}

/** Delegate interface for raw ATIF document persistence. */
export interface AtifDocumentDelegate {
  /** Read an ATIF document by ID. Returns undefined if not found. */
  readonly read: (docId: string) => Promise<AtifDocument | undefined>;
  /** Write an ATIF document by ID (full replace). */
  readonly write: (docId: string, doc: AtifDocument) => Promise<void>;
  /** List all document IDs. */
  readonly list: () => Promise<readonly string[]>;
  /** Delete a document by ID. Returns true if deleted. */
  readonly delete: (docId: string) => Promise<boolean>;
}

/** Create an in-memory ATIF document store for testing. */
export function createInMemoryAtifDocumentStore(
  config: AtifDocumentStoreConfig,
): TrajectoryDocumentStore {
  const docs = new Map<string, AtifDocument>();
  return createAtifDocumentStore(config, createInMemoryAtifDelegate(docs));
}

/** Create an in-memory delegate (exposed for testing). */
export function createInMemoryAtifDelegate(
  docs: Map<string, AtifDocument> = new Map(),
): AtifDocumentDelegate {
  return {
    async read(docId: string): Promise<AtifDocument | undefined> {
      return docs.get(docId);
    },
    async write(docId: string, doc: AtifDocument): Promise<void> {
      docs.set(docId, doc);
    },
    async list(): Promise<readonly string[]> {
      return [...docs.keys()];
    },
    async delete(docId: string): Promise<boolean> {
      return docs.delete(docId);
    },
  };
}

/** Create a TrajectoryDocumentStore backed by an ATIF document delegate. */
export function createAtifDocumentStore(
  config: AtifDocumentStoreConfig,
  delegate: AtifDocumentDelegate,
): TrajectoryDocumentStore {
  const maxSize = config.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;

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

      const existing = await delegate.read(docId);
      const doc = existing ?? createEmptyDoc(docId);

      // Convert new steps to ATIF format
      const newAtifDoc = mapRichTrajectoryToAtif(steps, {
        sessionId: docId,
        agentName: config.agentName,
        ...(config.agentVersion !== undefined ? { agentVersion: config.agentVersion } : {}),
      });

      // Extract agent-level info from steps (model name, tool definitions)
      const modelName = steps.find((s) => s.kind === "model_call")?.identifier;
      const toolDefs = steps
        .filter((s) => s.metadata !== undefined)
        .flatMap((s) => {
          const tools = (s.metadata as Record<string, unknown>)?.tools;
          return Array.isArray(tools)
            ? (tools as readonly { readonly name: string; readonly description?: string }[])
            : [];
        });

      // Merge steps into existing document, enriching agent metadata
      const merged: AtifDocument = {
        ...doc,
        agent: {
          ...doc.agent,
          ...(modelName !== undefined && doc.agent.model_name === undefined
            ? { model_name: modelName }
            : {}),
          ...(toolDefs.length > 0 && doc.agent.tool_definitions === undefined
            ? {
                tool_definitions: toolDefs.map((t) => ({
                  name: t.name,
                  ...(t.description !== undefined ? { description: t.description } : {}),
                })),
              }
            : {}),
        },
        steps: [...doc.steps, ...newAtifDoc.steps],
      };

      // Enforce size cap: prune oldest steps if over budget
      const serialized = JSON.stringify(merged);
      if (serialized.length > maxSize && merged.steps.length > 1) {
        const pruned = pruneToSize(merged, maxSize);
        await delegate.write(docId, pruned);
      } else {
        await delegate.write(docId, merged);
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

      const allSteps = mapAtifToRichTrajectory(doc);
      return allSteps.filter((step) => step.stepIndex >= startIndex && step.stepIndex < endIndex);
    },

    async getSize(docId: string): Promise<number> {
      const doc = await delegate.read(docId);
      if (doc === undefined) return 0;
      return JSON.stringify(doc).length;
    },

    async prune(olderThanMs: number): Promise<number> {
      const docIds = await delegate.list();
      // let: mutable counter for pruned entries
      let pruned = 0;

      for (const docId of docIds) {
        const doc = await delegate.read(docId);
        if (doc === undefined) continue;

        // Use the timestamp of the last step to determine age
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

/** Prune oldest steps from a document until it fits within maxSize. */
function pruneToSize(doc: AtifDocument, maxSize: number): AtifDocument {
  const steps = [...doc.steps];

  // Remove oldest steps (from the front) until under budget
  while (steps.length > 1) {
    steps.shift();
    const candidate: AtifDocument = { ...doc, steps };
    if (JSON.stringify(candidate).length <= maxSize) {
      return candidate;
    }
  }

  // If even one step is over budget, keep just the last step
  return { ...doc, steps };
}
