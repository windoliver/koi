/**
 * Shared test utilities for CLI command tests (start, serve).
 *
 * Extracted from start.test.ts to avoid duplication across command tests.
 */

import { mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Mock channel factory
// ---------------------------------------------------------------------------

export interface MockChannel {
  readonly connect: ReturnType<typeof mock>;
  readonly disconnect: ReturnType<typeof mock>;
  readonly send: ReturnType<typeof mock>;
  readonly onMessage: ReturnType<typeof mock>;
}

export function createMockChannel(): MockChannel {
  return {
    connect: mock(() => Promise.resolve()),
    disconnect: mock(() => Promise.resolve()),
    send: mock(() => Promise.resolve()),
    onMessage: mock((_handler: (msg: unknown) => void | Promise<void>) => () => {}),
  };
}

interface MockChannelAdapter {
  readonly name: string;
  readonly capabilities: {
    readonly text: boolean;
    readonly images: boolean;
    readonly files: boolean;
    readonly buttons: boolean;
    readonly audio: boolean;
    readonly video: boolean;
    readonly threads: boolean;
    readonly supportsA2ui: boolean;
  };
  readonly connect: ReturnType<typeof mock>;
  readonly disconnect: ReturnType<typeof mock>;
  readonly send: ReturnType<typeof mock>;
  readonly onMessage: ReturnType<typeof mock>;
}

export function createMockChannelAdapter(mockCh: MockChannel): MockChannelAdapter {
  return {
    name: "mock-channel",
    capabilities: {
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: false,
      supportsA2ui: false,
    },
    connect: mockCh.connect,
    disconnect: mockCh.disconnect,
    send: mockCh.send,
    onMessage: mockCh.onMessage,
  };
}

// ---------------------------------------------------------------------------
// Mock model handler
// ---------------------------------------------------------------------------

interface MockModelResponse {
  readonly content: string;
  readonly model: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export const mockModelHandler = async (request: {
  readonly messages: readonly {
    readonly content: readonly { readonly kind: string; readonly text?: string }[];
  }[];
}): Promise<MockModelResponse> => {
  const inputText = request.messages
    .flatMap((m) => m.content)
    .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
  return {
    content: `[echo] ${inputText}`,
    model: "mock-model",
    usage: {
      inputTokens: inputText.length,
      outputTokens: inputText.length + 7,
    },
  };
};

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

export function makeTempDir(prefix = "koi-test"): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

export function createManifestFile(dir: string, content?: string): string {
  const manifestContent =
    content ??
    [
      "name: test-agent",
      "version: 0.1.0",
      "description: A test agent",
      "model:",
      "  name: anthropic:claude-sonnet-4-5-20250929",
    ].join("\n");

  const filePath = join(dir, "koi.yaml");
  writeFileSync(filePath, manifestContent);
  return filePath;
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tempDirs.length = 0;
}

// ---------------------------------------------------------------------------
// Stderr/stdout capture
// ---------------------------------------------------------------------------

export interface OutputCapture {
  readonly chunks: string[];
  readonly restore: () => void;
}

export function captureStderr(): OutputCapture {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    chunks,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

export function captureStdout(): OutputCapture {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    chunks,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Process.exit mock
// ---------------------------------------------------------------------------

export interface ExitMock {
  readonly code: () => number | undefined;
  readonly restore: () => void;
}

export function mockProcessExit(): ExitMock {
  const original = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code: number) => {
    exitCode = code;
    throw new Error(`process.exit(${code})`);
  }) as never;
  return {
    code: () => exitCode,
    restore: () => {
      process.exit = original;
    },
  };
}

// ---------------------------------------------------------------------------
// Inbound message factory
// ---------------------------------------------------------------------------

interface InboundTestMessage {
  readonly content: readonly { readonly kind: "text"; readonly text: string }[];
  readonly senderId: string;
  readonly threadId?: string;
  readonly timestamp: number;
}

export function createInboundMessage(
  text: string,
  senderId = "test-user",
  threadId?: string,
): InboundTestMessage {
  return {
    content: [{ kind: "text" as const, text }],
    senderId,
    ...(threadId !== undefined ? { threadId } : {}),
    timestamp: Date.now(),
  };
}
