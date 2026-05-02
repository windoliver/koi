/**
 * Build a user-visible one-liner for a non-"completed" terminal stop reason.
 *
 * The message prefers `metadata.source` / `metadata.message` set by the
 * turn-runner when available so users see why the turn died.
 */
export function explainNonCompletedStop(stopReason: string, metadata: unknown): string {
  const meta =
    (metadata as
      | {
          readonly source?: string;
          readonly message?: string;
          readonly providerDetail?: { readonly error?: { readonly message?: string } | string };
          readonly terminatedBy?: string;
          readonly terminationReason?: string;
          readonly elapsedMs?: number;
        }
      | undefined) ?? undefined;
  const providerMsg = (() => {
    const pd = meta?.providerDetail?.error;
    if (typeof pd === "string") return pd;
    return pd?.message;
  })();
  const effectiveMsg = meta?.message ?? providerMsg;
  const detail = effectiveMsg !== undefined ? ` — ${effectiveMsg}` : "";
  const source = meta?.source !== undefined ? ` (${meta.source})` : "";
  if (meta?.terminatedBy === "activity-timeout") {
    const reason = meta.terminationReason ?? "unknown";
    const elapsed = typeof meta.elapsedMs === "number" ? meta.elapsedMs : 0;
    const seconds = Math.round(elapsed / 1000);
    const label =
      reason === "idle" ? "inactivity" : reason === "wall_clock" ? "wall-clock" : reason;
    return `\n[Turn interrupted by activity timeout (${label}) after ${seconds}s.]\n`;
  }
  switch (stopReason) {
    case "max_turns":
      return `\n[Turn ended: model reached the per-turn tool-call budget without producing a final reply${detail}. Try a more specific prompt, or split the work across multiple turns.]\n`;
    case "interrupted":
      return "\n[Turn interrupted before the model produced a reply.]\n";
    case "hook_blocked":
      return `\n[Turn blocked by a security gate${detail}.]\n`;
    case "error":
      return `\n[Turn failed${source}${detail}.]\n`;
    default:
      return `\n[Turn ended without a reply: ${stopReason}${detail}.]\n`;
  }
}
