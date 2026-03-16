/**
 * Consent handlers — extracted from tui-app.ts.
 *
 * Manages the consent prompt flow: approve, deny, details, dismiss.
 */

import type { TuiStore } from "../state/store.js";
import type { DataSourceDeps } from "./tui-data-sources.js";
import { approveDataSource, rejectDataSource, viewDataSourceSchema } from "./tui-data-sources.js";

/** Dependencies for consent operations. */
export interface ConsentDeps {
  readonly store: TuiStore;
  readonly dsDeps: DataSourceDeps;
  readonly addLifecycleMessage: (event: string) => void;
}

/** Approve the first pending consent source. */
export function consentApprove(deps: ConsentDeps): void {
  const pending = deps.store.getState().pendingConsent;
  if (pending === undefined || pending.length === 0) return;
  const first = pending[0];
  if (first === undefined) return;
  approveDataSource(first.name, deps.dsDeps).catch(() => {});
  deps.store.dispatch({ kind: "clear_pending_consent" });
  deps.store.dispatch({ kind: "set_view", view: "agents" });
}

/** Deny all pending consent sources. */
export function consentDeny(deps: ConsentDeps): void {
  const pending = deps.store.getState().pendingConsent;
  if (pending !== undefined) {
    for (const s of pending) {
      rejectDataSource(s.name, deps.dsDeps).catch(() => {});
    }
  }
  deps.store.dispatch({ kind: "clear_pending_consent" });
  deps.store.dispatch({ kind: "set_view", view: "agents" });
  deps.addLifecycleMessage("Data source denied");
}

/** View schema details of the first pending source. */
export function consentDetails(deps: ConsentDeps): void {
  const pending = deps.store.getState().pendingConsent;
  if (pending === undefined || pending.length === 0) return;
  const first = pending[0];
  if (first === undefined) return;
  viewDataSourceSchema(first.name, deps.dsDeps).catch(() => {});
}

/** Dismiss consent prompts without action. */
export function closeConsent(deps: ConsentDeps): void {
  deps.store.dispatch({ kind: "clear_pending_consent" });
  const session = deps.store.getState().activeSession;
  deps.store.dispatch({ kind: "set_view", view: session !== null ? "console" : "agents" });
}
