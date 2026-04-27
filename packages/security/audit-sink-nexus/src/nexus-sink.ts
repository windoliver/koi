import type { AuditEntry, AuditSink } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import {
  DEFAULT_BASE_PATH,
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
  type NexusAuditSinkConfig,
} from "./config.js";

export function createNexusAuditSink(config: NexusAuditSinkConfig): AuditSink {
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  interface BufferEntry {
    readonly entry: AuditEntry;
    readonly path: string; // computed at enqueue so retries use the same Nexus path
  }

  // let justified: mutable buffer swapped atomically on flush
  let buffer: BufferEntry[] = [];
  // let justified: lifecycle state
  let timer: ReturnType<typeof setInterval> | undefined;
  let flushPromise: Promise<void> | undefined;
  let entrySeq = 0;

  function computePath(entry: AuditEntry): string {
    const safeSession = entry.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const seq = entrySeq++;
    return `${basePath}/${safeSession}/${entry.timestamp}-${entry.turnIndex}-${entry.kind}-${seq}.json`;
  }

  async function writeEntry(transport: NexusTransport, buffered: BufferEntry): Promise<void> {
    const result = await transport.call("write", {
      path: buffered.path,
      content: JSON.stringify(buffered.entry),
    });
    if (!result.ok) {
      throw new Error(result.error.message, { cause: result.error });
    }
  }

  async function drainBuffer(): Promise<void> {
    if (buffer.length === 0) return;

    const batch = buffer;
    buffer = [];

    const results = await Promise.allSettled(
      batch.map((buffered) => writeEntry(config.transport, buffered)),
    );

    const failed = batch.filter((_, i) => results[i]?.status === "rejected");
    if (failed.length > 0) {
      buffer = [...failed, ...buffer]; // re-enqueue with same paths for idempotent retry
    }

    const firstFailed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (firstFailed !== undefined) {
      throw new Error("Failed to write audit entry", { cause: firstFailed.reason });
    }
  }

  function startFlush(): Promise<void> {
    if (flushPromise !== undefined) return flushPromise;
    flushPromise = drainBuffer().finally(() => {
      flushPromise = undefined;
    });
    return flushPromise;
  }

  function ensureTimer(): void {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      void startFlush().catch(() => {}); // fire-and-forget on interval
    }, flushIntervalMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  const log = async (entry: AuditEntry): Promise<void> => {
    buffer = [...buffer, { entry, path: computePath(entry) }];
    ensureTimer();
    if (buffer.length >= batchSize) {
      void startFlush().catch(() => {}); // fire-and-forget
    }
  };

  const flush = async (): Promise<void> => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    // Await any in-flight size-triggered flush first, then drain what remains
    if (flushPromise !== undefined) await flushPromise.catch(() => {});
    await drainBuffer();
  };

  function extractListFiles(value: unknown): readonly { readonly path: string }[] {
    if (Array.isArray(value)) return value as { readonly path: string }[];
    if (
      typeof value === "object" &&
      value !== null &&
      "files" in value &&
      Array.isArray((value as { files: unknown }).files)
    ) {
      return (value as { files: { readonly path: string }[] }).files;
    }
    return [];
  }

  function extractContent(value: unknown): string {
    if (typeof value === "string") return value;
    if (
      typeof value === "object" &&
      value !== null &&
      "content" in value &&
      typeof (value as { content: unknown }).content === "string"
    ) {
      return (value as { content: string }).content;
    }
    throw new Error("unexpected NFS read response shape");
  }

  const query = async (sessionId: string): Promise<readonly AuditEntry[]> => {
    await flush();

    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const listResult = await config.transport.call<unknown>("list", {
      path: `${basePath}/${safeSession}`,
    });
    if (!listResult.ok) {
      throw new Error(
        `[audit-sink-nexus] query failed: unable to list audit entries for session ${sessionId}: ${listResult.error.message}`,
        { cause: listResult.error },
      );
    }

    const files = extractListFiles(listResult.value);
    const entries: AuditEntry[] = [];
    for (const file of files) {
      const readResult = await config.transport.call<unknown>("read", { path: file.path });
      if (readResult.ok) {
        try {
          entries.push(JSON.parse(extractContent(readResult.value)) as AuditEntry);
        } catch {
          // Skip malformed individual entries — log at caller's discretion
        }
      }
    }

    return entries.sort((a, b) =>
      a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.turnIndex - b.turnIndex,
    );
  };

  return { log, flush, query };
}
