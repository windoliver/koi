/**
 * TrajectoryDocumentStore backed by ATIF format with pluggable persistence.
 * Ported from archive/v1/packages/mm/middleware-ace/src/atif-store.ts.
 */

import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core";
import { mapAtifToRichTrajectory, mapRichTrajectoryToAtif } from "./atif-mapper.js";
import type { AtifAgent, AtifDocument, AtifStep, AtifToolDefinition } from "./atif-types.js";

/** Default size cap for ATIF documents (10MB). */
const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;

export interface AtifDocumentStoreConfig {
  readonly agentName: string;
  readonly agentVersion?: string;
  readonly maxSizeBytes?: number;
}

export type AtifDocumentHeader = Omit<AtifDocument, "steps">;

export interface AtifDocumentAppendState {
  readonly document: AtifDocumentHeader;
  readonly stepCount: number;
  readonly nextStepIndex: number;
  readonly lastTimestampMs: number;
  readonly sizeBytes: number;
}

export interface AtifDocumentAppendBatch extends AtifDocumentAppendState {
  readonly startIndex: number;
  readonly steps: readonly AtifStep[];
}

/** Delegate interface for raw ATIF document persistence. */
export interface AtifDocumentDelegate {
  readonly read: (docId: string) => Promise<AtifDocument | undefined>;
  readonly write: (docId: string, doc: AtifDocument) => Promise<void>;
  readonly list: () => Promise<readonly string[]>;
  readonly delete: (docId: string) => Promise<boolean>;
  readonly readAppendState?: (docId: string) => Promise<AtifDocumentAppendState | undefined>;
  readonly appendSteps?: (docId: string, batch: AtifDocumentAppendBatch) => Promise<void>;
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

  function createEmptyHeader(docId: string): AtifDocumentHeader {
    return {
      schema_version: "ATIF-v1.6",
      session_id: docId,
      agent: {
        name: config.agentName,
        ...(config.agentVersion !== undefined ? { version: config.agentVersion } : {}),
      },
    };
  }

  function createEmptyDoc(docId: string): AtifDocument {
    return { ...createEmptyHeader(docId), steps: [] };
  }

  return {
    async append(docId: string, steps: readonly RichTrajectoryStep[]): Promise<void> {
      if (steps.length === 0) return;

      const unlock = await mutex.lock(docId);
      try {
        if (supportsAppend(delegate)) {
          await appendUsingChunkDelegate(
            docId,
            steps,
            config,
            maxSize,
            delegate,
            createEmptyHeader,
          );
          return;
        }

        const existing = await delegate.read(docId);
        const doc = existing ?? createEmptyDoc(docId);

        const prepared = prepareAppend(config, docId, stripSteps(doc), doc.steps, steps);
        const merged: AtifDocument = {
          ...prepared.document,
          steps: [...doc.steps, ...prepared.steps],
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

export function createAtifAppendStateFromDocument(doc: AtifDocument): AtifDocumentAppendState {
  return {
    document: stripSteps(doc),
    stepCount: doc.steps.length,
    nextStepIndex: nextStepIndex(doc.steps),
    lastTimestampMs: lastTimestampMs(doc.steps),
    sizeBytes: JSON.stringify(doc).length,
  };
}

function supportsAppend(
  delegate: AtifDocumentDelegate,
): delegate is AtifDocumentDelegate &
  Required<Pick<AtifDocumentDelegate, "readAppendState" | "appendSteps">> {
  return delegate.readAppendState !== undefined && delegate.appendSteps !== undefined;
}

async function appendUsingChunkDelegate(
  docId: string,
  steps: readonly RichTrajectoryStep[],
  config: AtifDocumentStoreConfig,
  maxSize: number,
  delegate: AtifDocumentDelegate &
    Required<Pick<AtifDocumentDelegate, "readAppendState" | "appendSteps">>,
  createEmptyHeader: (docId: string) => AtifDocumentHeader,
): Promise<void> {
  const state = await delegate.readAppendState(docId);
  const currentHeader = state?.document ?? createEmptyHeader(docId);
  const prepared = prepareAppend(
    config,
    docId,
    currentHeader,
    [],
    steps,
    state?.nextStepIndex,
    state?.lastTimestampMs,
  );
  const projectedSize = estimateAppendedSize(
    state,
    currentHeader,
    prepared.document,
    prepared.steps,
  );

  if (projectedSize <= maxSize) {
    await delegate.appendSteps(docId, {
      document: prepared.document,
      steps: prepared.steps,
      startIndex: prepared.startIndex,
      stepCount: (state?.stepCount ?? 0) + prepared.steps.length,
      nextStepIndex: prepared.nextStepIndex,
      lastTimestampMs: prepared.lastTimestampMs,
      sizeBytes: projectedSize,
    });
    return;
  }

  const existing = await delegate.read(docId);
  const doc: AtifDocument = existing ?? { ...currentHeader, steps: [] };
  const merged: AtifDocument = {
    ...prepared.document,
    steps: [...doc.steps, ...prepared.steps],
  };
  await delegate.write(docId, pruneToSize(merged, maxSize));
}

function prepareAppend(
  config: AtifDocumentStoreConfig,
  docId: string,
  header: AtifDocumentHeader,
  existingSteps: readonly AtifStep[],
  steps: readonly RichTrajectoryStep[],
  baseIndexOverride?: number,
  lastTimestampOverride?: number,
): AtifDocumentAppendBatch {
  // Reassign stepIndex to be globally unique across the document.
  // Enforce monotonic timestamps as a safety net for L1 emitters that
  // lack clock injection (#1558). When a step's timestamp goes backward
  // (concurrent Date.now() race), the original timestamp is preserved
  // in metadata._original_timestamp so auditors can reconstruct true
  // chronology. The per-stream monotonic clock handles most cases;
  // this only fires for engine-compose instrumentation timestamps.
  const baseIndex = baseIndexOverride ?? nextStepIndex(existingSteps);
  const lastExistingTs = lastTimestampOverride ?? lastTimestampMs(existingSteps);
  let prevTs = lastExistingTs;
  const reindexedSteps = steps.map((s, i) => {
    const ts = s.timestamp;
    if (ts > prevTs) {
      prevTs = ts;
      return { ...s, stepIndex: baseIndex + i };
    }
    const adjusted = prevTs + 1;
    prevTs = adjusted;
    return {
      ...s,
      stepIndex: baseIndex + i,
      timestamp: adjusted,
      metadata: {
        ...(s.metadata ?? {}),
        _original_timestamp: ts,
      },
    };
  });

  const newAtifDoc = mapRichTrajectoryToAtif(reindexedSteps, {
    sessionId: docId,
    agentName: config.agentName,
    ...(config.agentVersion !== undefined ? { agentVersion: config.agentVersion } : {}),
  });

  const document: AtifDocumentHeader = {
    ...header,
    agent: enrichAgentMetadata(header.agent, steps),
  };

  return {
    document,
    steps: newAtifDoc.steps,
    startIndex: baseIndex,
    stepCount: existingSteps.length + newAtifDoc.steps.length,
    nextStepIndex: baseIndex + newAtifDoc.steps.length,
    lastTimestampMs: prevTs,
    sizeBytes: 0,
  };
}

function estimateAppendedSize(
  state: AtifDocumentAppendState | undefined,
  currentHeader: AtifDocumentHeader,
  nextHeader: AtifDocumentHeader,
  steps: readonly AtifStep[],
): number {
  if (state === undefined) {
    return JSON.stringify({ ...nextHeader, steps }).length;
  }

  const currentEmptySize = JSON.stringify({ ...currentHeader, steps: [] }).length;
  const nextEmptySize = JSON.stringify({ ...nextHeader, steps: [] }).length;
  const stepBytes = steps.reduce((total, step) => total + JSON.stringify(step).length, 0);
  const commaBytes =
    steps.length === 0 ? 0 : state.stepCount > 0 ? steps.length : Math.max(0, steps.length - 1);
  return state.sizeBytes + (nextEmptySize - currentEmptySize) + stepBytes + commaBytes;
}

function stripSteps(doc: AtifDocument): AtifDocumentHeader {
  const { steps: _steps, ...header } = doc;
  return header;
}

function nextStepIndex(steps: readonly AtifStep[]): number {
  const lastStep = steps[steps.length - 1];
  return lastStep === undefined ? 0 : lastStep.step_id + 1;
}

function lastTimestampMs(steps: readonly AtifStep[]): number {
  const lastStep = steps[steps.length - 1];
  if (lastStep === undefined) return 0;
  const timestampMs = new Date(lastStep.timestamp).getTime();
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

/** Prune oldest steps until document fits within maxSize. */
function pruneToSize(doc: AtifDocument, maxSize: number): AtifDocument {
  if (doc.steps.length <= 1) return { ...doc, steps: [...doc.steps] };

  // Find the earliest retained index that fits. Keeping this logarithmic avoids
  // repeatedly shifting and reserializing every suffix for large documents.
  let low = 0;
  let high = doc.steps.length - 1;
  let best = doc.steps.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate: AtifDocument = { ...doc, steps: doc.steps.slice(mid) };
    if (JSON.stringify(candidate).length <= maxSize) {
      best = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return { ...doc, steps: doc.steps.slice(best) };
}
