import type { AttachFsm } from "./attach-fsm.js";
import { createDetachedFrame, detachDebugger } from "./detach-helpers.js";
import type { ExtensionStorage } from "./storage.js";

export interface AdminClearGrantsRequest {
  readonly scope: "all" | "origin";
  readonly origin?: string | undefined;
}

export async function respondToAdminClearGrants(deps: {
  readonly storage: ExtensionStorage;
  readonly fsm: AttachFsm;
  readonly request?: AdminClearGrantsRequest | undefined;
  readonly emitFrame: (
    frame:
      | {
          readonly kind: "detached";
          readonly sessionId: string;
          readonly tabId: number;
          readonly reason:
            | "navigated_away"
            | "private_origin"
            | "tab_closed"
            | "devtools_opened"
            | "extension_reload"
            | "unknown";
          readonly priorDetachSuccess?: boolean | undefined;
        }
      | {
          readonly kind: "admin_clear_grants_ack";
          readonly clearedOrigins: readonly string[];
          readonly detachedTabs: readonly number[];
        },
  ) => void;
}): Promise<void> {
  const scope = deps.request?.scope ?? "all";
  const targetOrigin = deps.request?.origin;

  // Validate: origin-scoped requests MUST supply an origin. Without this,
  // a caller that sent `{ scope: "origin" }` (missing origin) would silently
  // widen to a global wipe — destructive under-validation.
  if (scope === "origin" && targetOrigin === undefined) {
    deps.emitFrame({
      kind: "admin_clear_grants_ack",
      clearedOrigins: [],
      detachedTabs: [],
    });
    return;
  }

  let clearedOrigins: readonly string[];
  let clearedPrivateOrigins: readonly string[];

  if (scope === "origin" && targetOrigin !== undefined) {
    // Scoped revocation: remove the persistent always-grant AND the
    // private-origin allowlist entry for this origin, AND revoke any
    // per-tab allow_once entries whose live session is on this origin.
    // The allow_once key is (tabId, documentId), not keyed by origin
    // directly — so we resolve origin→tabId via the live FSM state.
    //
    // Other origins' grants stay intact.
    await deps.storage.removeAlwaysGrant(targetOrigin);
    const priv = await deps.storage.getPrivateOriginAllowlist();
    const filteredPriv = priv.filter((o) => o !== targetOrigin);
    const removedFromPriv = filteredPriv.length < priv.length;
    if (removedFromPriv) {
      await deps.storage.setPrivateOriginAllowlist(filteredPriv);
    }
    for (const session of deps.fsm.getAttachedStates()) {
      if (session.origin === targetOrigin) {
        await deps.storage.revokeAllowOnceForTab(session.tabId);
      }
    }
    clearedOrigins = [targetOrigin];
    clearedPrivateOrigins = removedFromPriv ? [targetOrigin] : [];
  } else {
    // scope === "all": wipe everything.
    const [always, priv] = await Promise.all([
      deps.storage.clearAlwaysGrants(),
      deps.storage.clearPrivateOriginAllowlist(),
      deps.storage.clearAllowOnceGrants(),
    ]);
    clearedOrigins = always;
    clearedPrivateOrigins = priv;
  }

  const detachedTabs: number[] = [];
  for (const session of deps.fsm.getAttachedStates()) {
    // For origin-scoped revocation, only detach sessions whose origin matches.
    if (scope === "origin" && targetOrigin !== undefined && session.origin !== targetOrigin) {
      continue;
    }
    const outcome = await detachDebugger(session.tabId);
    detachedTabs.push(session.tabId);
    deps.emitFrame(createDetachedFrame(session, "unknown", outcome.ok));
  }

  deps.emitFrame({
    kind: "admin_clear_grants_ack",
    clearedOrigins: [...clearedOrigins, ...clearedPrivateOrigins],
    detachedTabs,
  });
}
