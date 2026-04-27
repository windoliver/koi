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

  // let justified: mutable buffer swapped atomically on flush
  let buffer: AuditEntry[] = [];
  // let justified: lifecycle state
  let timer: ReturnType<typeof setInterval> | undefined;
  let flushing = false;
  let entrySeq = 0;

  function computePath(entry: AuditEntry): string {
    const safeSession = entry.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const seq = entrySeq++;
    return `${basePath}/${safeSession}/${entry.timestamp}-${entry.turnIndex}-${entry.kind}-${seq}.json`;
  }

  async function writeEntry(transport: NexusTransport, entry: AuditEntry): Promise<void> {
    const result = await transport.call("write", {
      path: computePath(entry),
      content: JSON.stringify(entry),
    });
    if (!result.ok) {
      throw new Error(result.error.message, { cause: result.error });
    }
  }

  async function flushBuffer(): Promise<void> {
    if (buffer.length === 0 || flushing) return;

    flushing = true;
    const batch = buffer;
    buffer = [];

    try {
      const results = await Promise.allSettled(
        batch.map((entry) => writeEntry(config.transport, entry)),
      );

      const failed = batch.filter((_, i) => results[i]?.status === "rejected");
      if (failed.length > 0) {
        buffer = [...failed, ...buffer]; // re-enqueue for next flush
      }

      const firstFailed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (firstFailed !== undefined) {
        throw new Error("Failed to write audit entry", { cause: firstFailed.reason });
      }
    } finally {
      flushing = false;
    }
  }

  function ensureTimer(): void {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      void flushBuffer().catch(() => {}); // fire-and-forget on interval
    }, flushIntervalMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  const log = async (entry: AuditEntry): Promise<void> => {
    buffer = [...buffer, entry];
    ensureTimer();
    if (buffer.length >= batchSize) {
      void flushBuffer().catch(() => {}); // fire-and-forget
    }
  };

  const flush = async (): Promise<void> => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    await flushBuffer();
  };

  const query = async (sessionId: string): Promise<readonly AuditEntry[]> => {
    await flush();

    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const listResult = await config.transport.call<readonly { readonly path: string }[]>("list", {
      path: `${basePath}/${safeSession}`,
    });
    if (!listResult.ok) return [];

    const entries: AuditEntry[] = [];
    for (const file of listResult.value) {
      const readResult = await config.transport.call<string>("read", { path: file.path });
      if (readResult.ok) {
        try {
          entries.push(JSON.parse(readResult.value) as AuditEntry);
        } catch {
          // Skip malformed entries
        }
      }
    }

    return entries.sort((a, b) =>
      a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.turnIndex - b.turnIndex,
    );
  };

  return { log, flush, query };
}
