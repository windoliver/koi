/**
 * TUI data source operations — CRUD for data source management.
 *
 * Extracted from tui-app. Uses typed AdminClient methods instead of raw fetch.
 */

import type { AdminClient } from "@koi/dashboard-client";
import type { DataSourceSummary } from "@koi/dashboard-types";
import type { TuiStore } from "../state/store.js";

/** Dependencies injected by tui-app for data source operations. */
export interface DataSourceDeps {
  readonly store: TuiStore;
  readonly client: AdminClient;
  readonly addLifecycleMessage: (event: string) => void;
}

/** Fetch and display all data sources. */
export async function openDataSources(deps: DataSourceDeps): Promise<void> {
  deps.store.dispatch({ kind: "set_data_sources_loading", loading: true });
  deps.store.dispatch({ kind: "set_view", view: "datasources" });

  const result = await deps.client.listDataSources();
  if (result.ok) {
    deps.store.dispatch({ kind: "set_data_sources", sources: result.value });
  } else {
    deps.store.dispatch({ kind: "set_data_sources", sources: [] });
  }
}

/** Approve a data source by name and refresh the list. */
export async function approveDataSource(name: string, deps: DataSourceDeps): Promise<void> {
  const result = await deps.client.approveDataSource(name);
  if (result.ok) {
    deps.addLifecycleMessage(`Data source "${name}" approved`);
    await openDataSources(deps);
  } else {
    deps.addLifecycleMessage(`Failed to approve "${name}"`);
  }
}

/** Reject a data source by name (best-effort). */
export async function rejectDataSource(name: string, deps: DataSourceDeps): Promise<void> {
  await deps.client.rejectDataSource(name);
}

/** Fetch and display schema for a data source. */
export async function viewDataSourceSchema(name: string, deps: DataSourceDeps): Promise<void> {
  deps.store.dispatch({ kind: "set_source_detail_loading", loading: true });
  deps.store.dispatch({ kind: "set_view", view: "sourcedetail" });

  const result = await deps.client.getDataSourceSchema(name);
  if (result.ok) {
    deps.store.dispatch({ kind: "set_source_detail", detail: result.value });
  } else {
    deps.store.dispatch({ kind: "set_source_detail", detail: null });
    deps.addLifecycleMessage(`Schema not available for "${name}"`);
  }
}

/** Trigger server-side rescan for new data sources. */
export async function rescanDataSources(deps: DataSourceDeps): Promise<void> {
  deps.addLifecycleMessage("Re-scanning environment for data sources...");
  const result = await deps.client.rescanDataSources();
  if (result.ok) {
    deps.store.dispatch({ kind: "set_data_sources", sources: result.value });
    deps.addLifecycleMessage(`Scan complete: ${String(result.value.length)} data source(s)`);
  } else {
    deps.addLifecycleMessage("Re-scan failed — refreshing list");
    await openDataSources(deps);
  }
}

/** Forward consent prompts for newly discovered data sources. */
export function forwardConsentPrompts(hasDiscovery: boolean, deps: DataSourceDeps): void {
  if (!hasDiscovery) return;

  openDataSources(deps)
    .then(() => {
      const sources = deps.store.getState().dataSources;
      const pending = sources.filter((s: DataSourceSummary) => s.status === "pending");
      if (pending.length > 0) {
        deps.store.dispatch({ kind: "set_pending_consent", sources: pending });
        deps.store.dispatch({ kind: "set_view", view: "consent" });
      }
    })
    .catch(() => {});
}
