import type { MatchEntry } from "@koi/core";

export interface BashOutputBufferConfig {
  readonly maxBytes: number;
  readonly maxMatches?: number;
}

export interface BufferSnapshot {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface MatchesResult {
  readonly kind: "matches";
  readonly entries: readonly MatchEntry[];
  readonly cursor: string;
  readonly dropped_before_cursor: number;
  readonly truncated: boolean;
}

export interface MatchQuery {
  readonly event?: string | undefined;
  readonly stream?: "stdout" | "stderr" | undefined;
  readonly offset?: string | undefined;
}

export interface BashOutputBuffer {
  readonly write: (stream: "stdout" | "stderr", chunk: string) => void;
  readonly snapshot: () => BufferSnapshot;
  readonly recordMatch: (entry: MatchEntry) => void;
  readonly queryMatches: (q: MatchQuery) => MatchesResult;
}

const DEFAULT_MAX_MATCHES = 64;

/**
 * Live in-memory buffer for a single bash_background task.
 *
 * - Main stream: FIFO-truncated per-stream capture up to `maxBytes` each. Used
 *   by `task_output(taskId)` to return buffered output in any state.
 * - Match side-buffer: FIFO of MatchEntry up to `maxMatches` (default 64). Used
 *   by `task_output(taskId, { matches_only: true })` for matched-line retrieval
 *   that survives main-stream truncation.
 *
 * Pure data structure — no I/O, no dependencies on the matcher, no process
 * management. Lifetime is tied to the owning task.
 */
export function createBashOutputBuffer(config: BashOutputBufferConfig): BashOutputBuffer {
  const maxBytes = Math.max(1, config.maxBytes);
  const maxMatches = config.maxMatches ?? DEFAULT_MAX_MATCHES;

  // let: each is mutated only via write(); justified as internal FIFO state
  let stdout = "";
  let stderr = "";
  let truncated = false;

  const matches: Array<{ readonly entry: MatchEntry; readonly seq: number }> = [];
  // let: incremented monotonically on each recordMatch(); justification: sequence counter
  let droppedCount = 0;
  let nextSeq = 0;

  function appendWithCap(current: string, chunk: string): string {
    const combined = current + chunk;
    if (combined.length > maxBytes) {
      truncated = true;
      return combined.slice(combined.length - maxBytes);
    }
    return combined;
  }

  return {
    write(stream, chunk) {
      if (stream === "stdout") {
        stdout = appendWithCap(stdout, chunk);
      } else {
        stderr = appendWithCap(stderr, chunk);
      }
    },

    snapshot(): BufferSnapshot {
      return { stdout, stderr, truncated };
    },

    recordMatch(entry) {
      const seq = nextSeq;
      nextSeq += 1;
      matches.push({ entry, seq });
      if (matches.length > maxMatches) {
        matches.shift();
        droppedCount += 1;
      }
    },

    queryMatches(q): MatchesResult {
      const seqOffset = q.offset !== undefined ? parseCursor(q.offset, q) : 0;

      const filtered = matches.filter(
        ({ entry, seq }) =>
          seq >= seqOffset &&
          (q.event === undefined || entry.event === q.event) &&
          (q.stream === undefined || entry.stream === q.stream),
      );

      const tail = filtered[filtered.length - 1];
      const lastSeq = tail !== undefined ? tail.seq : seqOffset - 1;
      const cursor = buildCursor(lastSeq + 1, q);

      return {
        kind: "matches",
        entries: filtered.map((s) => s.entry),
        cursor,
        dropped_before_cursor: droppedCount,
        truncated: droppedCount > 0,
      };
    },
  };
}

function buildCursor(seq: number, q: MatchQuery): string {
  const parts: string[] = [`s=${seq}`];
  if (q.event !== undefined) parts.push(`e=${q.event}`);
  if (q.stream !== undefined) parts.push(`r=${q.stream}`);
  return parts.join("&");
}

function parseCursor(cursor: string, q: MatchQuery): number {
  const parts = new Map<string, string>();
  for (const p of cursor.split("&")) {
    const eqIdx = p.indexOf("=");
    if (eqIdx > 0) {
      parts.set(p.slice(0, eqIdx), p.slice(eqIdx + 1));
    }
  }
  const expectedEvent = q.event ?? "";
  const expectedStream = q.stream ?? "";
  if ((parts.get("e") ?? "") !== expectedEvent || (parts.get("r") ?? "") !== expectedStream) {
    throw new Error(
      `cursor filter mismatch: cursor encodes event="${parts.get("e") ?? ""}" stream="${parts.get("r") ?? ""}" but query has event="${expectedEvent}" stream="${expectedStream}"`,
    );
  }
  const raw = parts.get("s") ?? "0";
  return Number.parseInt(raw, 10);
}
