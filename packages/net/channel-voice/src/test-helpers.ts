/**
 * Test helpers for @koi/channel-voice.
 *
 * Provides mock implementations of VoicePipeline, RoomService, and
 * TokenGenerator for use in unit and integration tests.
 */

import { mock } from "bun:test";
import type { TranscriptEvent, VoicePipeline } from "./pipeline.js";
import type { RoomService, TokenGenerator } from "./room.js";

// ---------------------------------------------------------------------------
// Mock VoicePipeline
// ---------------------------------------------------------------------------

export interface MockVoicePipeline extends VoicePipeline {
  /** Emit a transcript event to all registered handlers. */
  readonly emitTranscript: (event: TranscriptEvent) => void;
  /** Access the underlying mock functions for assertions. */
  readonly mocks: {
    readonly start: ReturnType<typeof mock>;
    readonly stop: ReturnType<typeof mock>;
    readonly speak: ReturnType<typeof mock>;
  };
}

export function createMockVoicePipeline(): MockVoicePipeline {
  // let requires justification: mutable running state managed by start/stop
  let running = false;
  // let requires justification: handler list updated by onTranscript and unsubscribe
  let handlers: readonly ((event: TranscriptEvent) => void)[] = [];

  const startMock = mock(async (_roomName: string): Promise<void> => {
    running = true;
  });

  const stopMock = mock(async (): Promise<void> => {
    running = false;
  });

  const speakMock = mock(async (_text: string): Promise<void> => {});

  const onTranscript = (handler: (event: TranscriptEvent) => void): (() => void) => {
    handlers = [...handlers, handler];
    // let requires justification: one-shot guard to prevent double-unsubscribe
    let removed = false;
    return (): void => {
      if (removed) {
        return;
      }
      removed = true;
      handlers = handlers.filter((h) => h !== handler);
    };
  };

  const emitTranscript = (event: TranscriptEvent): void => {
    const currentHandlers = handlers;
    for (const handler of currentHandlers) {
      handler(event);
    }
  };

  return {
    start: startMock,
    stop: stopMock,
    speak: speakMock,
    onTranscript,
    isRunning: () => running,
    emitTranscript,
    mocks: {
      start: startMock,
      stop: stopMock,
      speak: speakMock,
    },
  };
}

// ---------------------------------------------------------------------------
// Mock TranscriptEvent factory
// ---------------------------------------------------------------------------

export function createMockTranscript(text?: string, participantId?: string): TranscriptEvent {
  return {
    text: text ?? "Hello world",
    isFinal: true,
    participantId: participantId ?? "user-1",
    confidence: 0.95,
  };
}

// ---------------------------------------------------------------------------
// Mock RoomService
// ---------------------------------------------------------------------------

export interface MockRoomService extends RoomService {
  readonly mocks: {
    readonly createRoom: ReturnType<typeof mock>;
    readonly deleteRoom: ReturnType<typeof mock>;
  };
}

export function createMockRoomService(): MockRoomService {
  const createRoomMock = mock(async (_opts: { readonly name: string }): Promise<unknown> => ({}));
  const deleteRoomMock = mock(async (_name: string): Promise<void> => {});

  return {
    createRoom: createRoomMock,
    deleteRoom: deleteRoomMock,
    mocks: {
      createRoom: createRoomMock,
      deleteRoom: deleteRoomMock,
    },
  };
}

// ---------------------------------------------------------------------------
// Mock TokenGenerator
// ---------------------------------------------------------------------------

export interface MockTokenGenerator extends TokenGenerator {
  readonly mocks: {
    readonly generateToken: ReturnType<typeof mock>;
  };
}

export function createMockTokenGenerator(): MockTokenGenerator {
  const generateTokenMock = mock(
    async (roomName: string, _participantName: string): Promise<string> => {
      return `mock-jwt-${roomName}`;
    },
  );

  return {
    generateToken: generateTokenMock,
    mocks: {
      generateToken: generateTokenMock,
    },
  };
}
