import type {
  EngineState,
  SessionId,
  SessionPersistence,
  SessionTranscript,
  TranscriptEntry,
} from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

export interface NexusSessionBackendConfig {
  /** Configured Nexus transport. */
  readonly transport: NexusTransport;
  /** Base namespace for all session state. Defaults to "sessions". */
  readonly basePath?: string | undefined;
  /** In-process lock scope for read-modify-write operations. Defaults to basePath. */
  readonly lockScope?: string | undefined;
}

export interface SessionArtifactRecord {
  readonly artifactId: string;
  readonly content: string;
  readonly contentType?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  readonly createdAt: number;
}

export interface SessionArtifactStore {
  readonly saveArtifact: (sessionId: SessionId, artifact: SessionArtifactRecord) => Promise<void>;
  readonly loadArtifact: (
    sessionId: SessionId,
    artifactId: string,
  ) => Promise<SessionArtifactRecord | undefined>;
  readonly listArtifacts: (sessionId: SessionId) => Promise<readonly SessionArtifactRecord[]>;
  readonly removeArtifact: (sessionId: SessionId, artifactId: string) => Promise<void>;
}

export interface NexusSessionBackend {
  readonly transcript: SessionTranscript;
  readonly persistence: SessionPersistence;
  readonly artifacts: SessionArtifactStore;
  readonly saveTurn: (sessionId: SessionId, turn: TranscriptEntry) => Promise<void>;
  readonly loadHistory: (sessionId: SessionId) => Promise<readonly TranscriptEntry[]>;
  readonly saveCheckpoint: (sessionId: SessionId, state: EngineState) => Promise<void>;
  readonly loadCheckpoint: (sessionId: SessionId) => Promise<EngineState | undefined>;
  readonly close: () => void | Promise<void>;
}
