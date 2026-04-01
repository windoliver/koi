import { describe, expect, mock, test } from "bun:test";
import type { DataSourceSummary } from "@koi/dashboard-types";
import { createStore } from "../state/store.js";
import { createInitialState } from "../state/types.js";
import type { DataSourceDeps } from "./tui-data-sources.js";
import {
  approveDataSource,
  forwardConsentPrompts,
  openDataSources,
  rescanDataSources,
  viewDataSourceSchema,
} from "./tui-data-sources.js";

// ─── Helpers ────────────────────────────────────────────────────────────

function makeSources(
  count: number,
  status: DataSourceSummary["status"] = "approved",
): readonly DataSourceSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `source-${String(i)}`,
    protocol: "postgres",
    status,
    source: "env" as const,
  }));
}

function makeDeps(overrides: Partial<DataSourceDeps> = {}): DataSourceDeps & {
  readonly lifecycleMessages: readonly string[];
} {
  const store = overrides.store ?? createStore(createInitialState("http://localhost:3100"));
  const mutableMessages: string[] = [];
  return {
    store,
    client: {
      listDataSources: mock(() => Promise.resolve({ ok: true, value: makeSources(2) })),
      approveDataSource: mock(() => Promise.resolve({ ok: true, value: null })),
      rejectDataSource: mock(() => Promise.resolve({ ok: true, value: null })),
      getDataSourceSchema: mock(() =>
        Promise.resolve({ ok: true, value: { tables: ["users", "orders"] } }),
      ),
      rescanDataSources: mock(() => Promise.resolve({ ok: true, value: makeSources(3) })),
    } as unknown as DataSourceDeps["client"],
    addLifecycleMessage: mock((event: string) => {
      mutableMessages.push(event);
    }),
    get lifecycleMessages() {
      return mutableMessages;
    },
    ...overrides,
  };
}

// ─── openDataSources ────────────────────────────────────────────────────

describe("openDataSources", () => {
  test("sets loading state and switches to datasources view", async () => {
    const deps = makeDeps();

    await openDataSources(deps);

    expect(deps.store.getState().view).toBe("datasources");
    // Loading should be cleared after fetch completes
    expect(deps.store.getState().dataSourcesLoading).toBe(false);
  });

  test("populates data sources on success", async () => {
    const deps = makeDeps();

    await openDataSources(deps);

    expect(deps.store.getState().dataSources).toHaveLength(2);
    expect(deps.store.getState().dataSources[0]?.name).toBe("source-0");
  });

  test("sets empty sources on failure", async () => {
    const deps = makeDeps({
      client: {
        listDataSources: mock(() =>
          Promise.resolve({
            ok: false,
            error: { kind: "api_error" as const, code: "UNAVAILABLE", message: "down" },
          }),
        ),
      } as unknown as DataSourceDeps["client"],
    });

    await openDataSources(deps);

    expect(deps.store.getState().dataSources).toEqual([]);
    expect(deps.store.getState().view).toBe("datasources");
  });
});

// ─── approveDataSource ──────────────────────────────────────────────────

describe("approveDataSource", () => {
  test("approves and refreshes sources on success", async () => {
    const deps = makeDeps();

    await approveDataSource("db-1", deps);

    expect(deps.client.approveDataSource).toHaveBeenCalledWith("db-1");
    expect(deps.lifecycleMessages[0]).toContain('Data source "db-1" approved');
    // Should have called openDataSources to refresh
    expect(deps.client.listDataSources).toHaveBeenCalled();
  });

  test("shows failure message on error", async () => {
    const deps = makeDeps({
      client: {
        approveDataSource: mock(() =>
          Promise.resolve({
            ok: false,
            error: { kind: "api_error" as const, code: "NOT_FOUND", message: "not found" },
          }),
        ),
      } as unknown as DataSourceDeps["client"],
    });

    await approveDataSource("db-missing", deps);

    expect(deps.lifecycleMessages[0]).toContain('Failed to approve "db-missing"');
  });
});

// ─── viewDataSourceSchema ───────────────────────────────────────────────

describe("viewDataSourceSchema", () => {
  test("sets loading and switches to sourcedetail view on success", async () => {
    const deps = makeDeps();

    await viewDataSourceSchema("db-1", deps);

    expect(deps.store.getState().view).toBe("sourcedetail");
    expect(deps.store.getState().sourceDetailLoading).toBe(false);
    expect(deps.store.getState().sourceDetail).toEqual({ tables: ["users", "orders"] });
  });

  test("sets null detail and shows message on failure", async () => {
    const deps = makeDeps({
      client: {
        getDataSourceSchema: mock(() =>
          Promise.resolve({
            ok: false,
            error: { kind: "api_error" as const, code: "NOT_FOUND", message: "not found" },
          }),
        ),
      } as unknown as DataSourceDeps["client"],
    });

    await viewDataSourceSchema("db-missing", deps);

    expect(deps.store.getState().sourceDetail).toBeNull();
    expect(deps.lifecycleMessages[0]).toContain('Schema not available for "db-missing"');
  });
});

// ─── rescanDataSources ──────────────────────────────────────────────────

describe("rescanDataSources", () => {
  test("shows scanning message and updates sources on success", async () => {
    const deps = makeDeps();

    await rescanDataSources(deps);

    expect(deps.lifecycleMessages[0]).toContain("Re-scanning");
    expect(deps.lifecycleMessages[1]).toContain("Scan complete: 3 data source(s)");
    expect(deps.store.getState().dataSources).toHaveLength(3);
  });

  test("falls back to openDataSources on failure", async () => {
    const listMock = mock(() => Promise.resolve({ ok: true, value: makeSources(1) }));
    const deps = makeDeps({
      client: {
        rescanDataSources: mock(() =>
          Promise.resolve({
            ok: false,
            error: { kind: "api_error" as const, code: "ERROR", message: "scan failed" },
          }),
        ),
        listDataSources: listMock,
      } as unknown as DataSourceDeps["client"],
    });

    await rescanDataSources(deps);

    expect(deps.lifecycleMessages[0]).toContain("Re-scanning");
    expect(deps.lifecycleMessages[1]).toContain("Re-scan failed");
    // Should have called openDataSources as fallback
    expect(listMock).toHaveBeenCalled();
  });
});

// ─── forwardConsentPrompts ──────────────────────────────────────────────

describe("forwardConsentPrompts", () => {
  test("no-ops when hasDiscovery is false", () => {
    const deps = makeDeps();
    forwardConsentPrompts(false, deps);
    expect(deps.client.listDataSources).not.toHaveBeenCalled();
  });

  test("opens data sources and shows consent view for pending sources", async () => {
    const pendingSources: readonly DataSourceSummary[] = [
      { name: "db-new", protocol: "postgres", status: "pending", source: "env" },
      { name: "db-old", protocol: "sqlite", status: "approved", source: "manifest" },
    ];
    const deps = makeDeps({
      client: {
        listDataSources: mock(() => Promise.resolve({ ok: true, value: pendingSources })),
      } as unknown as DataSourceDeps["client"],
    });

    forwardConsentPrompts(true, deps);

    // Wait for the async chain to settle
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(deps.store.getState().pendingConsent).toHaveLength(1);
    expect(deps.store.getState().pendingConsent?.[0]?.name).toBe("db-new");
    expect(deps.store.getState().view).toBe("consent");
  });

  test("does not switch to consent view when no pending sources", async () => {
    const approvedSources: readonly DataSourceSummary[] = [
      { name: "db-ok", protocol: "postgres", status: "approved", source: "env" },
    ];
    const deps = makeDeps({
      client: {
        listDataSources: mock(() => Promise.resolve({ ok: true, value: approvedSources })),
      } as unknown as DataSourceDeps["client"],
    });

    forwardConsentPrompts(true, deps);

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    // Should have opened datasources view from openDataSources, but NOT consent
    expect(deps.store.getState().view).toBe("datasources");
    expect(deps.store.getState().pendingConsent).toBeUndefined();
  });
});
