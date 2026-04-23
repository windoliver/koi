import type { NmCdpEvent, NmCdpResult, NmChunk, NmFrame } from "../../src/native-host/nm-frame.js";

const DEFAULT_CHUNK_BYTES = 700_000;
const DEFAULT_FRAME_THRESHOLD_BYTES = 900_000;

// Browser-safe base64 helpers. The extension bundle runs under Chrome's MV3
// service worker (esbuild target: browser) where `Buffer` is not guaranteed
// to exist. Use `TextEncoder`/`btoa`/`atob` instead.
function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

function base64Decode(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export interface ChunkSender {
  readonly sendFrame: (frame: NmFrame) => void;
  readonly sendResult: (frame: NmCdpResult) => void;
  readonly sendEvent: (frame: NmCdpEvent) => void;
}

export interface ChunkReceiver {
  readonly addChunk: (frame: NmChunk) => void;
  readonly tick: (now: number) => void;
  readonly size: () => number;
}

interface ChunkEntry {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly payloadKind: NmChunk["payloadKind"];
  readonly total: number;
  readonly parts: Map<number, string>;
  lastSeenAt: number;
}

function chunkString(value: string, chunkSize: number): readonly string[] {
  const output: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    output.push(value.slice(index, index + chunkSize));
  }
  return output;
}

export function createChunkSender(
  emit: (frame: NmFrame) => void,
  options?: {
    readonly frameThresholdBytes?: number;
    readonly chunkBytes?: number;
  },
): ChunkSender {
  const frameThresholdBytes = options?.frameThresholdBytes ?? DEFAULT_FRAME_THRESHOLD_BYTES;
  const chunkBytes = options?.chunkBytes ?? DEFAULT_CHUNK_BYTES;

  function sendChunked(
    sessionId: string,
    correlationId: string,
    payloadKind: NmChunk["payloadKind"],
    payloadJson: string,
  ): void {
    const parts = chunkString(base64Encode(payloadJson), chunkBytes);
    parts.forEach((data, index) => {
      emit({
        kind: "chunk",
        sessionId,
        correlationId,
        payloadKind,
        index,
        total: parts.length,
        data,
      });
    });
  }

  return {
    sendFrame(frame: NmFrame): void {
      emit(frame);
    },
    sendResult(frame: NmCdpResult): void {
      const payloadJson = JSON.stringify(frame.result);
      if (utf8Length(payloadJson) <= frameThresholdBytes) {
        emit(frame);
        return;
      }
      sendChunked(frame.sessionId, `r:${frame.id}`, "result_value", payloadJson);
    },
    sendEvent(frame: NmCdpEvent): void {
      const payloadJson = JSON.stringify(frame);
      if (utf8Length(payloadJson) <= frameThresholdBytes) {
        emit(frame);
        return;
      }
      sendChunked(frame.sessionId, `e:${frame.eventId}`, "event_frame", payloadJson);
    },
  };
}

export function createChunkReceiver(
  onFrame: (frame: NmFrame) => void,
  onTimeout?: (info: { readonly sessionId: string; readonly correlationId: string }) => void,
): ChunkReceiver {
  const entries = new Map<string, ChunkEntry>();

  function entryKey(sessionId: string, correlationId: string): string {
    return `${sessionId}\u0000${correlationId}`;
  }

  function finalize(entry: ChunkEntry): void {
    const ordered = [...entry.parts.entries()].sort(([a], [b]) => a - b);
    if (ordered.length !== entry.total) return;
    const payload = base64Decode(ordered.map(([, value]) => value).join(""));
    const parsed = JSON.parse(payload) as unknown;
    if (entry.payloadKind === "result_value") {
      const id = Number.parseInt(entry.correlationId.slice(2), 10);
      onFrame({
        kind: "cdp_result",
        sessionId: entry.sessionId,
        id,
        result: parsed,
      });
      return;
    }
    onFrame(parsed as NmFrame);
  }

  return {
    addChunk(frame): void {
      const key = entryKey(frame.sessionId, frame.correlationId);
      const entry = entries.get(key) ?? {
        sessionId: frame.sessionId,
        correlationId: frame.correlationId,
        payloadKind: frame.payloadKind,
        total: frame.total,
        parts: new Map<number, string>(),
        lastSeenAt: Date.now(),
      };
      entry.parts.set(frame.index, frame.data);
      entry.lastSeenAt = Date.now();
      entries.set(key, entry);
      if (entry.parts.size === entry.total) {
        entries.delete(key);
        finalize(entry);
      }
    },
    tick(now): void {
      for (const [key, entry] of entries.entries()) {
        if (now - entry.lastSeenAt <= 30_000) continue;
        entries.delete(key);
        onTimeout?.({ sessionId: entry.sessionId, correlationId: entry.correlationId });
      }
    },
    size: () => entries.size,
  };
}
