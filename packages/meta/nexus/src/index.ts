/**
 * @koi/nexus — L3 composition bundle for Nexus backend wiring.
 *
 * One-line Nexus wiring: single config → all backends auto-wired,
 * auto-provisioned, auto-scoped per agent during assembly.
 *
 * Usage:
 * ```typescript
 * import { createNexusStack } from "@koi/nexus";
 *
 * const nexus = await createNexusStack({
 *   baseUrl: "http://localhost:2026",
 *   apiKey: process.env.NEXUS_API_KEY!,
 * });
 *
 * const runtime = await createKoi({
 *   manifest,
 *   adapter,
 *   registry: nexus.backends.registry,
 *   providers: [...nexus.providers],
 *   middleware: [...nexus.middlewares],
 * });
 * ```
 */

// ── Types: namespace ──────────────────────────────────────────────────
export type { AgentNamespace, GroupNamespace } from "./namespace.js";
export { computeAgentNamespace, computeGroupNamespace } from "./namespace.js";
// ── Functions ──────────────────────────────────────────────────────────
export { createNexusStack } from "./nexus-stack.js";
// ── Types: bundle output ───────────────────────────────────────────────
// ── Types: configuration ──────────────────────────────────────────────
export type {
  AgentBackendOverrides,
  AuditOverrides,
  EventsOverrides,
  FilesystemOverrides,
  ForgeOverrides,
  GatewayOverrides,
  GlobalBackendOverrides,
  MailboxOverrides,
  MemoryOverrides,
  NameServiceOverrides,
  NexusBundle,
  NexusConnectionConfig,
  NexusGlobalBackends,
  NexusStackConfig,
  OptInOverrides,
  PayOverrides,
  PermissionsOverrides,
  RegistryOverrides,
  ResolvedNexusConnection,
  ResolvedNexusMeta,
  SchedulerOverrides,
  SearchOverrides,
  SessionOverrides,
  SnapshotsOverrides,
  WorkspaceOverrides,
} from "./types.js";
export { validateNexusStackConfig } from "./validate-config.js";
