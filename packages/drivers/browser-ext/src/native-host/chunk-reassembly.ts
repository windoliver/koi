import type { NmFrame } from "./nm-frame.js";

type PayloadKind = "result_value" | "event_frame";

interface ChunkEntry {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly total: number;
  payloadKind: PayloadKind | null;
  readonly chunks: Map<number, string>;
  lastSeenAt: number;
}

function key(sessionId: string, correlationId: string): string {
  return `${sessionId}\u0000${correlationId}`;
}

export interface ChunkReassemblyEvents {
  readonly onFrameReady: (frame: NmFrame) => void;
  readonly onTimeout: (info: {
    readonly sessionId: string;
    readonly correlationId: string;
  }) => void;
  readonly onGroupDrop: (info: {
    readonly sessionId: string;
    readonly correlationId: string;
    readonly reason: "mismatched_payload_kind" | "parse_error";
  }) => void;
}

export interface ChunkBuffer {
  readonly add: (chunk: Extract<NmFrame, { kind: "chunk" }>) => void;
  readonly tick: (now: number) => void;
  readonly size: () => number;
}

export function createChunkBuffer(config: {
  readonly timeoutMs?: number;
  readonly events: ChunkReassemblyEvents;
}): ChunkBuffer {
  const timeoutMs = config.timeoutMs ?? 30_000;
  const buffer = new Map<string, ChunkEntry>();

  function finalize(entry: ChunkEntry): void {
    if (entry.payloadKind === null) return;
    // The extension chunks by first base64-encoding the full JSON payload and
    // then slicing that single base64 string. Base64 is NOT independently
    // decodable per-fragment unless every boundary lands on a 4-char multiple,
    // so reassemble the raw base64 string first and decode exactly once.
    const base64Parts: string[] = [];
    for (let i = 0; i < entry.total; i++) {
      const part = entry.chunks.get(i);
      if (part === undefined) return;
      base64Parts.push(part);
    }
    const decoded = Buffer.from(base64Parts.join(""), "base64").toString("utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      config.events.onGroupDrop({
        sessionId: entry.sessionId,
        correlationId: entry.correlationId,
        reason: "parse_error",
      });
      buffer.delete(key(entry.sessionId, entry.correlationId));
      return;
    }
    buffer.delete(key(entry.sessionId, entry.correlationId));
    config.events.onFrameReady(parsed as NmFrame);
  }

  return {
    add(chunk): void {
      const k = key(chunk.sessionId, chunk.correlationId);
      let entry = buffer.get(k);
      if (!entry) {
        entry = {
          sessionId: chunk.sessionId,
          correlationId: chunk.correlationId,
          total: chunk.total,
          payloadKind: chunk.payloadKind,
          chunks: new Map(),
          lastSeenAt: Date.now(),
        };
        buffer.set(k, entry);
      } else if (entry.payloadKind !== chunk.payloadKind) {
        config.events.onGroupDrop({
          sessionId: chunk.sessionId,
          correlationId: chunk.correlationId,
          reason: "mismatched_payload_kind",
        });
        buffer.delete(k);
        return;
      }
      entry.chunks.set(chunk.index, chunk.data);
      entry.lastSeenAt = Date.now();
      if (entry.chunks.size === entry.total) {
        finalize(entry);
      }
    },
    tick(now): void {
      for (const [k, entry] of buffer.entries()) {
        if (now - entry.lastSeenAt > timeoutMs) {
          buffer.delete(k);
          config.events.onTimeout({
            sessionId: entry.sessionId,
            correlationId: entry.correlationId,
          });
        }
      }
    },
    size: () => buffer.size,
  };
}
