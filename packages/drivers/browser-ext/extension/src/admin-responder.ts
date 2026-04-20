import type { AttachFsm } from "./attach-fsm.js";
import { createDetachedFrame, detachDebugger } from "./detach-helpers.js";
import type { ExtensionStorage } from "./storage.js";

export async function respondToAdminClearGrants(deps: {
  readonly storage: ExtensionStorage;
  readonly fsm: AttachFsm;
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
  const [clearedOrigins, clearedPrivateOrigins] = await Promise.all([
    deps.storage.clearAlwaysGrants(),
    deps.storage.clearPrivateOriginAllowlist(),
    deps.storage.clearAllowOnceGrants(),
  ]);

  const detachedTabs: number[] = [];
  for (const session of deps.fsm.getAttachedStates()) {
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
