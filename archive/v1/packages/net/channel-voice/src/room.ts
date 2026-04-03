/**
 * Room management — creates/destroys LiveKit rooms and generates access tokens.
 *
 * Tracks active sessions in an immutable Map, enforces maxConcurrentSessions,
 * and runs a periodic cleanup sweep for stale rooms.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import {
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  DEFAULT_ROOM_EMPTY_TIMEOUT_SECONDS,
  type VoiceChannelConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoiceSession {
  readonly roomName: string;
  readonly token: string;
  readonly wsUrl: string;
}

interface SessionEntry {
  readonly roomName: string;
  readonly createdAt: number;
}

export interface RoomManager {
  /** Create a new voice session (room + access token). */
  readonly createSession: () => Promise<Result<VoiceSession, KoiError>>;
  /** End and clean up a session by room name. Idempotent. */
  readonly endSession: (roomName: string) => Promise<void>;
  /** Number of currently active sessions. */
  readonly activeSessions: () => number;
  /** Start the periodic cleanup sweep (60s interval). */
  readonly startCleanupSweep: () => void;
  /** Stop the cleanup sweep. */
  readonly stopCleanupSweep: () => void;
  /** End all active sessions. */
  readonly endAllSessions: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Room service interface for testability
// ---------------------------------------------------------------------------

export interface RoomService {
  readonly createRoom: (opts: { readonly name: string }) => Promise<unknown>;
  readonly deleteRoom: (name: string) => Promise<void>;
}

export interface TokenGenerator {
  readonly generateToken: (roomName: string, participantName: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function generateRoomName(): string {
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createRoomManager(
  config: VoiceChannelConfig,
  overrides?: {
    readonly roomService?: RoomService;
    readonly tokenGenerator?: TokenGenerator;
  },
): RoomManager {
  const maxSessions = config.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
  const emptyTimeoutMs =
    (config.roomEmptyTimeoutSeconds ?? DEFAULT_ROOM_EMPTY_TIMEOUT_SECONDS) * 1000;

  const roomService: RoomService =
    overrides?.roomService ??
    new RoomServiceClient(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret);

  const tokenGenerator: TokenGenerator = overrides?.tokenGenerator ?? {
    generateToken: async (roomName: string, participantName: string): Promise<string> => {
      const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
        identity: participantName,
      });
      token.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true });
      return await token.toJwt();
    },
  };

  // let requires justification: sessions map mutated by createSession/endSession lifecycle
  let sessions = new Map<string, SessionEntry>();
  // let requires justification: cleanup interval handle, started/cleared by sweep lifecycle
  let sweepInterval: ReturnType<typeof setInterval> | undefined;

  const createSession = async (): Promise<Result<VoiceSession, KoiError>> => {
    if (sessions.size >= maxSessions) {
      return {
        ok: false,
        error: {
          code: "RATE_LIMIT",
          message: `Maximum concurrent sessions (${maxSessions}) reached`,
          retryable: RETRYABLE_DEFAULTS.RATE_LIMIT,
        },
      };
    }

    const roomName = generateRoomName();
    await roomService.createRoom({ name: roomName });
    const jwt = await tokenGenerator.generateToken(roomName, `user-${Date.now()}`);

    // Replace with new Map to maintain immutability of iteration
    const next = new Map(sessions);
    next.set(roomName, { roomName, createdAt: Date.now() });
    sessions = next;

    return {
      ok: true,
      value: {
        roomName,
        token: jwt,
        wsUrl: config.livekitUrl,
      },
    };
  };

  const endSession = async (roomName: string): Promise<void> => {
    if (!sessions.has(roomName)) {
      return; // idempotent — unknown room is no-op
    }

    const next = new Map(sessions);
    next.delete(roomName);
    sessions = next;

    try {
      await roomService.deleteRoom(roomName);
    } catch (e: unknown) {
      // Log but don't throw — cleanup should not fail the caller
      console.error("[channel-voice] Failed to delete room:", roomName, e);
    }
  };

  const endAllSessions = async (): Promise<void> => {
    const roomNames = [...sessions.keys()];
    sessions = new Map();
    await Promise.allSettled(roomNames.map((name) => roomService.deleteRoom(name)));
  };

  const activeSessions = (): number => sessions.size;

  const runCleanupSweep = (): void => {
    const now = Date.now();
    for (const [roomName, entry] of sessions) {
      if (now - entry.createdAt > emptyTimeoutMs) {
        void endSession(roomName);
      }
    }
  };

  const startCleanupSweep = (): void => {
    if (sweepInterval !== undefined) {
      return;
    }
    sweepInterval = setInterval(runCleanupSweep, 60_000);
  };

  const stopCleanupSweep = (): void => {
    if (sweepInterval !== undefined) {
      clearInterval(sweepInterval);
      sweepInterval = undefined;
    }
  };

  return {
    createSession,
    endSession,
    activeSessions,
    startCleanupSweep,
    stopCleanupSweep,
    endAllSessions,
  };
}
