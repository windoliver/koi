/**
 * CLI channel adapter — stdin/stdout I/O for interactive terminal sessions.
 *
 * Implements the ChannelAdapter contract from @koi/core for local CLI use.
 * Reads user input via readline on stdin, writes agent output to stdout.
 */

import * as readline from "node:readline";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ContentBlock,
  InboundMessage,
  MessageHandler,
  OutboundMessage,
} from "@koi/core";

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
} as const satisfies ChannelCapabilities;

/**
 * Extracts a text description for a non-text content block,
 * suitable for display on stderr.
 */
function describeBlock(block: ContentBlock): string {
  switch (block.kind) {
    case "text":
      return block.text;
    case "file":
      return `[file: ${block.name ?? block.url}]`;
    case "image":
      return `[image: ${block.alt ?? block.url}]`;
    case "button":
      return `[button: ${block.label}]`;
    case "custom":
      return `[custom: ${block.type}]`;
  }
}

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

  let rl: readline.Interface | undefined;
  let handlers: readonly MessageHandler[] = [];
  let connected = false;

  const connect = async (): Promise<void> => {
    if (connected) {
      return;
    }

    rl = readline.createInterface({
      input: input as NodeJS.ReadableStream,
      output: output as NodeJS.WritableStream,
      prompt,
    });

    rl.on("line", (line: string) => {
      const message: InboundMessage = {
        content: [{ kind: "text", text: line }],
        senderId,
        timestamp: Date.now(),
      };

      // Notify all registered handlers — fire-and-forget with error logging
      const currentHandlers = handlers;
      for (const handler of currentHandlers) {
        Promise.resolve(handler(message)).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          (errorOutput as NodeJS.WritableStream).write(`Channel handler error: ${msg}\n`);
        });
      }

      // Show prompt again for next input
      rl?.prompt();
    });

    rl.prompt();
    connected = true;
  };

  const disconnect = async (): Promise<void> => {
    if (rl !== undefined) {
      rl.close();
      rl = undefined;
    }
    connected = false;
  };

  const send = async (message: OutboundMessage): Promise<void> => {
    for (const block of message.content) {
      if (block.kind === "text") {
        (output as NodeJS.WritableStream).write(`${block.text}\n`);
      } else {
        (errorOutput as NodeJS.WritableStream).write(`${describeBlock(block)}\n`);
      }
    }
  };

  const onMessage = (handler: MessageHandler): (() => void) => {
    handlers = [...handlers, handler];
    let removed = false;

    return (): void => {
      if (removed) {
        return;
      }
      removed = true;
      handlers = handlers.filter((h) => h !== handler);
    };
  };

  return {
    name: "cli",
    capabilities: CLI_CAPABILITIES,
    connect,
    disconnect,
    send,
    onMessage,
  };
}
