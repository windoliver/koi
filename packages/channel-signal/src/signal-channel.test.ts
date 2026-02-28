import { describe, expect, mock, test } from "bun:test";
import { testChannelAdapter } from "@koi/test-utils";
import type { SpawnFn } from "./config.js";
import { createSignalChannel } from "./signal-channel.js";

/** Creates a mock spawn that auto-resolves exit on kill. */
function createMockSpawn(): SpawnFn {
  return mock(() => {
    // let: resolve function for the exit promise
    let resolveExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    // let: controller for stdout stream
    let _controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        _controller = c;
      },
    });

    return {
      stdout,
      stdin: { write: mock(() => 0) },
      kill: mock(() => {
        resolveExit?.(0);
      }),
      exited,
    };
  });
}

function makeAdapter(): ReturnType<typeof createSignalChannel> {
  return createSignalChannel({
    account: "+1234567890",
    debounceMs: 0,
    _spawn: createMockSpawn(),
  });
}

describe("createSignalChannel", () => {
  describe("contract tests", () => {
    testChannelAdapter({
      createAdapter: () => makeAdapter(),
    });
  });

  describe("capabilities", () => {
    test("declares expected capabilities", () => {
      const adapter = makeAdapter();
      expect(adapter.capabilities).toEqual({
        text: true,
        images: true,
        files: true,
        buttons: false,
        audio: false,
        video: false,
        threads: false,
        supportsA2ui: false,
      });
    });

    test("name is 'signal'", () => {
      const adapter = makeAdapter();
      expect(adapter.name).toBe("signal");
    });
  });

  describe("lifecycle", () => {
    test("connect and disconnect complete without error", async () => {
      const adapter = makeAdapter();
      await adapter.connect();
      await adapter.disconnect();
    });

    test("connect starts signal-cli subprocess", async () => {
      const spawn = createMockSpawn();
      const adapter = createSignalChannel({
        account: "+1234567890",
        debounceMs: 0,
        _spawn: spawn,
      });

      await adapter.connect();
      expect(spawn).toHaveBeenCalledTimes(1);
      await adapter.disconnect();
    });
  });
});
