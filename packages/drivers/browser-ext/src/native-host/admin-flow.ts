import type { NmFrame } from "./nm-frame.js";

export interface AdminClearGrantsResult {
  readonly ok: boolean;
  readonly clearedOrigins?: readonly string[];
  readonly detachedTabs?: readonly number[];
  readonly error?: "PERMISSION" | "timeout";
}

export async function handleAdminClearGrants(deps: {
  readonly role: "driver" | "admin";
  readonly scope: "all" | "origin";
  readonly origin?: string | undefined;
  readonly sendNm: (frame: NmFrame) => void;
  readonly awaitAck: (timeoutMs: number) => Promise<{
    readonly clearedOrigins: readonly string[];
    readonly detachedTabs: readonly number[];
  } | null>;
  readonly timeoutMs?: number;
}): Promise<AdminClearGrantsResult> {
  if (deps.role !== "admin") {
    return { ok: false, error: "PERMISSION" };
  }
  const frame: NmFrame = deps.origin
    ? { kind: "admin_clear_grants", scope: deps.scope, origin: deps.origin }
    : { kind: "admin_clear_grants", scope: deps.scope };
  deps.sendNm(frame);
  const ack = await deps.awaitAck(deps.timeoutMs ?? 30_000);
  if (!ack) return { ok: false, error: "timeout" };
  return {
    ok: true,
    clearedOrigins: ack.clearedOrigins,
    detachedTabs: ack.detachedTabs,
  };
}
