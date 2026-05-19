import type { EngineState, SessionId, TranscriptEntry } from "@koi/core";
import { agentId } from "@koi/core";
import { createNexusSessionArtifactStore } from "./artifact-store.js";
import { DEFAULT_NEXUS_SESSION_BASE_PATH, validateBasePath } from "./paths.js";
import { createNexusSessionPersistence } from "./persistence-store.js";
import { createNexusTranscriptStore } from "./transcript-store.js";
import type { NexusSessionBackend, NexusSessionBackendConfig } from "./types.js";

type NexusSessionPersistence = NexusSessionBackend["persistence"];

export function createNexusSessionBackend(config: NexusSessionBackendConfig): NexusSessionBackend {
  const basePath = config.basePath ?? DEFAULT_NEXUS_SESSION_BASE_PATH;
  const validBasePath = validateBasePath(basePath);
  if (!validBasePath.ok) {
    throw new Error(validBasePath.error.message, { cause: validBasePath.error });
  }
  const lockScope = config.lockScope ?? basePath;
  const transcript = createNexusTranscriptStore(config.transport, basePath, lockScope);
  const persistence = createNexusSessionPersistence(config.transport, basePath, lockScope);
  const artifacts = createNexusSessionArtifactStore(config.transport, basePath);

  async function saveTurn(sessionId: SessionId, turn: TranscriptEntry): Promise<void> {
    const result = await transcript.append(sessionId, [turn]);
    if (!result.ok) throw new Error(result.error.message, { cause: result.error });
  }

  async function loadHistory(sessionId: SessionId): Promise<readonly TranscriptEntry[]> {
    const result = await transcript.load(sessionId);
    if (!result.ok) throw new Error(result.error.message, { cause: result.error });
    return result.value.entries;
  }

  return {
    transcript,
    persistence,
    artifacts,
    saveTurn,
    loadHistory,
    saveCheckpoint: (sessionId, state) => saveCheckpoint(persistence, sessionId, state),
    loadCheckpoint: (sessionId) => loadCheckpoint(persistence, sessionId),
    close: async () => {
      await transcript.close();
      await persistence.close();
    },
  };
}

async function saveCheckpoint(
  persistence: NexusSessionPersistence,
  sessionId: SessionId,
  state: EngineState,
): Promise<void> {
  const loaded = await persistence.loadSession(sessionId);
  if (loaded.ok) {
    await updateExistingCheckpoint(persistence, sessionId, state, loaded.value.lastPersistedAt);
    return;
  }
  if (loaded.error.code !== "NOT_FOUND") {
    throw new Error(loaded.error.message, { cause: loaded.error });
  }
  const saved = await persistence.saveSession(createCheckpointRecord(sessionId, state, Date.now()));
  if (!saved.ok) throw new Error(saved.error.message, { cause: saved.error });
}

async function updateExistingCheckpoint(
  persistence: NexusSessionPersistence,
  sessionId: SessionId,
  state: EngineState,
  expectedVersion: number,
): Promise<void> {
  const updated = await persistence.updateLastEngineState?.(
    sessionId,
    () => state,
    Date.now(),
    expectedVersion,
  );
  if (updated === undefined) throw new Error("Nexus persistence missing checkpoint support");
  if (!updated.ok) throw new Error(updated.error.message, { cause: updated.error });
}

function createCheckpointRecord(sessionId: SessionId, state: EngineState, now: number) {
  return {
    sessionId,
    agentId: agentId("nexus-session-backend"),
    manifestSnapshot: {
      name: "nexus-session-backend",
      version: "0.0.0",
      description: "Synthetic session record for checkpoint-only persistence",
      model: { name: "unknown" },
    },
    seq: 0,
    remoteSeq: 0,
    connectedAt: now,
    lastPersistedAt: now,
    lastEngineState: state,
    status: "idle" as const,
    metadata: { createdBy: "createNexusSessionBackend.saveCheckpoint" },
  };
}

async function loadCheckpoint(
  persistence: NexusSessionPersistence,
  sessionId: SessionId,
): Promise<EngineState | undefined> {
  const result = await persistence.loadSession(sessionId);
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND") return undefined;
    throw new Error(result.error.message, { cause: result.error });
  }
  return result.value.lastEngineState;
}
