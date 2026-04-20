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

  let clearedOrigins: readonly string[];
  let clearedPrivateOrigins: readonly string[];

  if (scope === "origin" && targetOrigin !== undefined) {
    // Scoped revocation: touch only the one origin. Leave allow_once grants,
    // other origins' always grants, and the private-origin allowlist intact
    // (the allowlist governs different sites and must not be wiped by an
    // origin-scoped request).
    await deps.storage.removeAlwaysGrant(targetOrigin);
    clearedOrigins = [targetOrigin];
    clearedPrivateOrigins = [];
  } else {
    // scope === "all" (or missing): wipe everything.
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
