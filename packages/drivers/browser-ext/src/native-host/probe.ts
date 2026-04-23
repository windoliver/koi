import { randomUUID } from "node:crypto";

import type { NmFrame } from "./nm-frame.js";
import type { OwnershipMap } from "./ownership-map.js";
import type { QuarantineJournal } from "./quarantine-journal.js";

export interface BootProbeResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * §8.5 boot-time attach_state_probe. Sends probe, awaits ack (bounded), seeds
 * orphan quarantine entries for any reported tabs not already in ownership.
 * Blocks host startup on timeout.
 */
export async function runBootProbe(deps: {
  readonly sendNm: (frame: NmFrame) => void;
  readonly awaitAck: (
    requestId: string,
    timeoutMs: number,
  ) => Promise<{ readonly attachedTabs: readonly number[] } | null>;
  readonly ownership: OwnershipMap;
  readonly quarantineJournal: QuarantineJournal;
  readonly writerEpoch: number;
  readonly writerSeq: number;
  readonly now: () => number;
  readonly timeoutMs?: number;
}): Promise<BootProbeResult> {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const requestId = randomUUID();
  deps.sendNm({ kind: "attach_state_probe", requestId });
  const ack = await deps.awaitAck(requestId, timeoutMs);
  if (!ack) return { ok: false, error: "probe_timeout" };

  for (const tabId of ack.attachedTabs) {
    if (deps.ownership.get(tabId)) continue;
    deps.ownership.set(tabId, {
      phase: "detaching_failed",
      clientId: "host",
      sessionId: "orphan",
      reason: "chrome_error",
      since: deps.now(),
    });
    await deps.quarantineJournal.addEntry({
      tabId,
      sessionId: "orphan",
      reason: "chrome_error",
      writerEpoch: deps.writerEpoch,
      writerSeq: deps.writerSeq,
    });
  }

  if (ack.attachedTabs.length > 0) {
    await new Promise<void>((r) => setTimeout(r, 2_000));
    const requestId2 = randomUUID();
    deps.sendNm({ kind: "attach_state_probe", requestId: requestId2 });
    await deps.awaitAck(requestId2, timeoutMs).catch(() => null);
  }
  return { ok: true };
}
