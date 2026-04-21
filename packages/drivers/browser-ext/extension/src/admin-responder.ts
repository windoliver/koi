import type { AttachFsm } from "./attach-fsm.js";
import { createDetachedFrame, detachDebugger } from "./detach-helpers.js";
import type { ExtensionStorage } from "./storage.js";

export interface AdminClearGrantsRequest {
  readonly requestId: string;
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
          readonly requestId: string;
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
      requestId: deps.request?.requestId ?? "",
      clearedOrigins: [],
      detachedTabs: [],
    });
    return;
  }

  let clearedOrigins: readonly string[];
  let clearedPrivateOrigins: readonly string[];

  if (scope === "origin" && targetOrigin !== undefined) {
    // Scoped revocation: remove the persistent always-grant AND the
    // private-origin allowlist entry for this origin. For one-time grants:
    // they are keyed by (tabId, documentId), not origin, so we cannot
    // selectively enumerate "all tabs that had an allow_once for this
    // origin" — detached tabs are not represented in the live FSM, so an
    // origin-only sweep via attached-state would leave dormant entries
    // behind. The conservative safe fallback is to wipe ALL allow_once
    // grants during an origin-scoped revocation: allow_once is by
    // construction session-scoped (chrome.storage.session is cleared on
    // browser restart), and losing unrelated allow_once entries just
    // costs an extra one-time consent prompt for those other origins.
    //
    // Other origins' persistent `always` grants and private-origin
    // allowlist entries stay intact.
    await deps.storage.removeAlwaysGrant(targetOrigin);
    const priv = await deps.storage.getPrivateOriginAllowlist();
    const filteredPriv = priv.filter((o) => o !== targetOrigin);
    const removedFromPriv = filteredPriv.length < priv.length;
    if (removedFromPriv) {
      await deps.storage.setPrivateOriginAllowlist(filteredPriv);
    }
    await deps.storage.clearAllowOnceGrants();
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
    // Drop FSM ownership of the tab BEFORE the detached frame is emitted.
    // Otherwise the stale `attached` entry would make the next attach
    // request for this tab bounce as `already_attached` even though Chrome
    // already tore the session down.
    deps.fsm.clearAttachedTab(session.tabId);
    deps.emitFrame(createDetachedFrame(session, "unknown", outcome.ok));
  }

  deps.emitFrame({
    kind: "admin_clear_grants_ack",
    requestId: deps.request?.requestId ?? "",
    clearedOrigins: [...clearedOrigins, ...clearedPrivateOrigins],
    detachedTabs,
  });
}
