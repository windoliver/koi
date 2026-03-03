/**
 * CLI channel adapter — stdin/stdout I/O for interactive terminal sessions.
 *
 * Implements the ChannelAdapter contract from @koi/core for local CLI use.
 * Reads user input via readline on stdin, writes agent output to stdout.
 *
 * Built on @koi/channel-base/createChannelAdapter() for all shared channel
 * behavior (lifecycle, handler dispatch, capability-aware rendering, etc.).
 *
 * Rendering note: image, file, and button blocks are downgraded to text
 * by renderBlocks() (since CLI declares these capabilities false) and written
 * to stdout. CustomBlock has no capability flag and passes through to stderr.
 */

import * as readline from "node:readline";
import { createChannelAdapter } from "@koi/channel-base";
import type { ChannelAdapter, ChannelCapabilities } from "@koi/core";

/**
 * Configuration for the CLI channel adapter.
 */
export interface CliChannelConfig {
  /** Readable stream for user input. Defaults to `process.stdin`. */
  readonly input?: NodeJS.ReadableStream;
  /** Writable stream for agent output. Defaults to `process.stdout`. */
  readonly output?: NodeJS.WritableStream;
  /** Writable stream for status/error messages. Defaults to `process.stderr`. */
  readonly errorOutput?: NodeJS.WritableStream;
  /** Prompt string shown before user input. Defaults to `"> "`. */
  readonly prompt?: string;
  /** Sender ID for inbound messages. Defaults to `"cli-user"`. */
  readonly senderId?: string;
}

const CLI_CAPABILITIES = {
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

/**
 * Creates a CLI channel adapter that reads from stdin and writes to stdout.
 *
 * @param config - Optional configuration overrides.
 * @returns A ChannelAdapter for CLI interaction.
 */
export function createCliChannel(config?: CliChannelConfig): ChannelAdapter {
  const input = config?.input ?? process.stdin;
  const output = config?.output ?? process.stdout;
  const errorOutput = config?.errorOutput ?? process.stderr;
  const prompt = config?.prompt ?? "> ";
  const senderId = config?.senderId ?? "cli-user";

  // let requires justification: readline interface created/destroyed by platform lifecycle
  let rl: readline.Interface | undefined;

  return createChannelAdapter<string>({
    name: "cli",
    capabilities: CLI_CAPABILITIES,

    platformConnect: async () => {
      rl = readline.createInterface({
        input: input as NodeJS.ReadableStream,
        output: output as NodeJS.WritableStream,
        prompt,
      });
      rl.prompt();
    },

    platformDisconnect: async () => {
      rl?.close();
      rl = undefined;
    },

    /**
     * After renderBlocks(), only TextBlock and CustomBlock arrive here.
     * TextBlock (including downgraded image/file/button) goes to stdout.
     * CustomBlock (no capability flag, passes through renderBlocks) goes to stderr.
     */
    platformSend: async (message) => {
      for (const block of message.content) {
        if (block.kind === "text") {
          (output as NodeJS.WritableStream).write(`${block.text}\n`);
        } else if (block.kind === "custom") {
          (errorOutput as NodeJS.WritableStream).write(`[custom: ${block.type}]\n`);
        }
        // image/file/button are downgraded to TextBlock by renderBlocks() — unreachable
      }
    },

    /**
     * Registers the dispatch callback on the readline 'line' event.
     * Called after platformConnect(), so rl is guaranteed to be defined.
     */
    onPlatformEvent: (handler) => {
      if (rl === undefined) {
        // Cannot happen: onPlatformEvent is called after platformConnect sets rl.
        return () => {};
      }
      const listener = (line: string): void => {
        handler(line);
        rl?.prompt();
      };
      rl.on("line", listener);
      return () => {
        rl?.off("line", listener);
      };
    },

    normalize: (line: string) => ({
      content: [{ kind: "text", text: line }],
      senderId,
      timestamp: Date.now(),
    }),

    onHandlerError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      (errorOutput as NodeJS.WritableStream).write(`Channel handler error: ${msg}\n`);
    },
  });
}
