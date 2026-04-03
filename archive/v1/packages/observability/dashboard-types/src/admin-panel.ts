/**
 * Admin panel configuration and saved view definitions.
 */

import type { FileSystemBackend } from "@koi/core";
import type { CommandDispatcher } from "./commands.js";
import type { DashboardConfig } from "./config.js";
import type { DashboardDataSource } from "./data-source.js";
import type { RuntimeViewDataSource } from "./runtime-views.js";

// ---------------------------------------------------------------------------
// Saved view definition
// ---------------------------------------------------------------------------

export interface SavedViewDefinition {
  readonly id: string;
  readonly label: string;
  /** Root path(s) to filter the file tree. */
  readonly rootPaths: readonly string[];
  /** Optional glob to further filter entries. */
  readonly globPattern?: string;
  /** URL query param value for this view. */
  readonly urlParam: string;
}

/** Built-in saved views — hardcoded, not user-configurable in Phase 1. */
export const SAVED_VIEWS: readonly SavedViewDefinition[] = [
  { id: "all", label: "All Files", rootPaths: ["/"], urlParam: "all" },
  { id: "agents", label: "Agents", rootPaths: ["/agents/"], urlParam: "agents" },
  {
    id: "self-improvement",
    label: "Self-Improvement",
    rootPaths: ["/agents/", "/global/bricks/"],
    globPattern: "**/bricks/*.json",
    urlParam: "self-improvement",
  },
  {
    id: "events",
    label: "Events",
    rootPaths: ["/agents/"],
    globPattern: "**/events/**",
    urlParam: "events",
  },
  {
    id: "sessions",
    label: "Sessions",
    rootPaths: ["/agents/"],
    globPattern: "**/session/**",
    urlParam: "sessions",
  },
  {
    id: "memory",
    label: "Memory",
    rootPaths: ["/agents/"],
    globPattern: "**/memory/**",
    urlParam: "memory",
  },
  {
    id: "workspaces",
    label: "Workspaces",
    rootPaths: ["/agents/"],
    globPattern: "**/workspace/**",
    urlParam: "workspaces",
  },
  { id: "gateway", label: "Gateway", rootPaths: ["/global/gateway/"], urlParam: "gateway" },
] as const;

// ---------------------------------------------------------------------------
// Admin panel data sources — injected into the handler factory
// ---------------------------------------------------------------------------

export interface AdminPanelDataSources {
  /** V1 data source (agents, channels, skills, metrics, SSE). */
  readonly dataSource: DashboardDataSource;
  /** File operations via Nexus filesystem backend. */
  readonly fileSystem?: FileSystemBackend;
  /** Computed runtime views (process tree, procfs, middleware, gateway). */
  readonly runtimeViews?: RuntimeViewDataSource;
  /** Imperative commands (suspend, resume, terminate, DLQ retry). */
  readonly commands?: CommandDispatcher;
}

export interface AdminPanelConfig extends DashboardConfig {
  /** Data sources for the admin panel. When absent, uses dataSource only. */
  readonly dataSources?: Omit<AdminPanelDataSources, "dataSource">;
}
