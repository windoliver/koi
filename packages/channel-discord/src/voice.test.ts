/**
 * Unit tests for voice connection lifecycle.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AudioPlayer, AudioResource, VoiceConnection } from "@discordjs/voice";
import type { VoiceDeps } from "./voice.js";
import { createVoiceManager } from "./voice.js";

// ---------------------------------------------------------------------------
// Mock voice deps
// ---------------------------------------------------------------------------

interface MockVoiceConnection {
  readonly subscribe: ReturnType<typeof mock>;
  readonly destroy: ReturnType<typeof mock>;
  readonly on: ReturnType<typeof mock>;
  readonly listeners: Map<string, Array<(...args: readonly unknown[]) => void>>;
  readonly emit: (event: string, ...args: readonly unknown[]) => void;
}

interface MockAudioPlayer {
  readonly play: ReturnType<typeof mock>;
  readonly stop: ReturnType<typeof mock>;
}

function createMockVoiceConnection(): MockVoiceConnection {
  const listeners = new Map<string, Array<(...args: readonly unknown[]) => void>>();
  return {
    subscribe: mock(() => {}),
    destroy: mock(() => {}),
    on: mock((event: string, listener: (...args: readonly unknown[]) => void) => {
      const existing = listeners.get(event) ?? [];
      listeners.set(event, [...existing, listener]);
    }),
    listeners,
    emit: (event: string, ...args: readonly unknown[]) => {
      const fns = listeners.get(event) ?? [];
      for (const fn of fns) {
        fn(...args);
      }
    },
  };
}

function createMockAudioPlayer(): MockAudioPlayer {
  return {
    play: mock(() => {}),
    stop: mock(() => {}),
  };
}

function createMockDeps(connectionOverride?: MockVoiceConnection): {
  readonly deps: VoiceDeps;
  readonly connection: MockVoiceConnection;
  readonly player: MockAudioPlayer;
} {
  const connection = connectionOverride ?? createMockVoiceConnection();
  const player = createMockAudioPlayer();
  return {
    deps: {
      joinVoiceChannel: mock(() => connection as unknown as VoiceConnection),
      createAudioPlayer: mock(() => player as unknown as AudioPlayer),
    },
    connection,
    player,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createVoiceManager — join", () => {
  test("joins a voice channel and returns connection info", () => {
    const { deps } = createMockDeps();
    const manager = createVoiceManager(deps);
    const vc = manager.joinVoice("guild-1", "vc-1", {});
    expect(vc.guildId).toBe("guild-1");
    expect(vc.channelId).toBe("vc-1");
    expect(deps.joinVoiceChannel).toHaveBeenCalledTimes(1);
  });

  test("subscribes audio player to connection", () => {
    const { deps, connection } = createMockDeps();
    const manager = createVoiceManager(deps);
    manager.joinVoice("guild-1", "vc-1", {});
    expect(connection.subscribe).toHaveBeenCalledTimes(1);
  });

  test("destroys existing connection when joining same guild", () => {
    const conn1 = createMockVoiceConnection();
    const conn2 = createMockVoiceConnection();
    // let requires justification: tracks which connection mock to return next
    let callCount = 0;
    const deps: VoiceDeps = {
      joinVoiceChannel: mock(() => {
        callCount += 1;
        return (callCount === 1 ? conn1 : conn2) as unknown as VoiceConnection;
      }),
      createAudioPlayer: mock(() => createMockAudioPlayer() as unknown as AudioPlayer),
    };

    const manager = createVoiceManager(deps);
    manager.joinVoice("guild-1", "vc-1", {});
    manager.joinVoice("guild-1", "vc-2", {});
    expect(conn1.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("createVoiceManager — leave", () => {
  test("destroys connection on leave", () => {
    const { deps, connection } = createMockDeps();
    const manager = createVoiceManager(deps);
    manager.joinVoice("guild-1", "vc-1", {});
    manager.leaveVoice("guild-1");
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });

  test("leave is safe when no connection exists", () => {
    const { deps } = createMockDeps();
    const manager = createVoiceManager(deps);
    // Should not throw
    manager.leaveVoice("guild-nonexistent");
  });
});

describe("createVoiceManager — destroyAll", () => {
  test("destroys all active connections", () => {
    const conn1 = createMockVoiceConnection();
    const conn2 = createMockVoiceConnection();
    // let requires justification: tracks call count for sequential mock returns
    let callCount = 0;
    const deps: VoiceDeps = {
      joinVoiceChannel: mock(() => {
        callCount += 1;
        return (callCount === 1 ? conn1 : conn2) as unknown as VoiceConnection;
      }),
      createAudioPlayer: mock(() => createMockAudioPlayer() as unknown as AudioPlayer),
    };

    const manager = createVoiceManager(deps);
    manager.joinVoice("guild-1", "vc-1", {});
    manager.joinVoice("guild-2", "vc-2", {});
    manager.destroyAll();
    expect(conn1.destroy).toHaveBeenCalledTimes(1);
    expect(conn2.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("createVoiceManager — playAudio", () => {
  test("plays audio through the player", () => {
    const { deps, player } = createMockDeps();
    const manager = createVoiceManager(deps);
    const vc = manager.joinVoice("guild-1", "vc-1", {});
    const fakeResource = {} as AudioResource;
    vc.playAudio(fakeResource);
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledWith(fakeResource);
  });
});

describe("createVoiceManager — destroy via returned handle", () => {
  test("destroy() on returned connection cleans up", () => {
    const { deps, connection } = createMockDeps();
    const manager = createVoiceManager(deps);
    const vc = manager.joinVoice("guild-1", "vc-1", {});
    vc.destroy();
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    // Leaving again should be safe (already cleaned up)
    manager.leaveVoice("guild-1");
  });
});

describe("createVoiceManager — auto-reconnect", () => {
  test("tracks disconnection and increments reconnect attempts", () => {
    const { deps, connection } = createMockDeps();
    const manager = createVoiceManager(deps);
    manager.joinVoice("guild-1", "vc-1", {});

    // Simulate disconnect
    connection.emit(
      "stateChange",
      { status: "ready" as const },
      { status: "disconnected" as const },
    );
    // Should not have destroyed — still has reconnect attempts
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  test("resets reconnect counter on successful reconnect", () => {
    const { deps, connection } = createMockDeps();
    const manager = createVoiceManager(deps);
    manager.joinVoice("guild-1", "vc-1", {});

    // Simulate disconnect then reconnect
    connection.emit(
      "stateChange",
      { status: "ready" as const },
      { status: "disconnected" as const },
    );
    connection.emit(
      "stateChange",
      { status: "disconnected" as const },
      { status: "ready" as const },
    );

    // Simulate another disconnect — should still have attempts left
    connection.emit(
      "stateChange",
      { status: "ready" as const },
      { status: "disconnected" as const },
    );
    expect(connection.destroy).not.toHaveBeenCalled();
  });
});
