/**
 * ComponentProvider that auto-wires agent-scoped Nexus backends during assembly.
 *
 * On attach(agent): discovers pid.id/pid.groupId, provisions namespace paths,
 * creates agent-scoped backends (forge, events, session, memory, snapshots,
 * filesystem, mailbox), and optionally wires scratchpad for group-scoped agents.
 *
 * On detach(agent): disposes per-agent resources and cleans up the disposal map.
 */

import type {
  Agent,
  AgentGroupId,
  AgentId,
  AttachResult,
  ComponentProvider,
  KoiMiddleware,
  SkippedComponent,
} from "@koi/core";
import { COMPONENT_PRIORITY, EVENTS, FILESYSTEM, MAILBOX, MEMORY, WORKSPACE } from "@koi/core";
import { createNexusFileSystem } from "@koi/filesystem-nexus";
import { createNexusMailbox } from "@koi/ipc-nexus";
import type { NexusClient } from "@koi/nexus-client";
import {
  createNexusEventBackend,
  createNexusForgeStore,
  createNexusMemoryBackend,
  createNexusSessionStore,
  createNexusSnapshotStore,
} from "@koi/nexus-store";
import { createScratchpadNexusProvider } from "@koi/scratchpad-nexus";
import { createNexusWorkspaceBackend } from "@koi/workspace-nexus";
import { computeAgentNamespace, computeGroupNamespace, ensureNamespace } from "./namespace.js";
import type { AgentBackendOverrides, NexusConnectionConfig, OptInOverrides } from "./types.js";

/** Maximum disposal map size before emitting a warning. */
const DISPOSAL_MAP_WARNING_THRESHOLD = 10_000;

/** Per-agent disposable resources tracked for cleanup. */
interface AgentDisposables {
  readonly mailbox?: Disposable | undefined;
  readonly scratchpadMiddleware?: KoiMiddleware | undefined;
}

/**
 * Creates a ComponentProvider that auto-wires Nexus backends per agent.
 *
 * Returns both the provider and any middleware collected from scratchpad wiring.
 */
export function createNexusAgentProvider(
  conn: NexusConnectionConfig,
  client: NexusClient,
  agentOverrides: AgentBackendOverrides = {},
  optIn: OptInOverrides = {},
): {
  readonly provider: ComponentProvider;
  readonly middlewares: readonly KoiMiddleware[];
} {
  const { baseUrl, apiKey } = conn;
  const fetchFn = conn.fetch;

  // Disposal map: agentId → disposable resources
  const disposalMap = new Map<string, AgentDisposables>();

  // Middleware collected across all agents (scratchpad flush)
  const middlewares: KoiMiddleware[] = [];

  const provider: ComponentProvider = {
    name: "nexus-agent",
    priority: COMPONENT_PRIORITY.BUNDLED,

    async attach(agent: Agent): Promise<AttachResult> {
      const agentId: AgentId = agent.pid.id;
      const agentIdStr = agentId as string;
      const groupId: AgentGroupId | undefined = agent.pid.groupId;
      const ns = computeAgentNamespace(agentId);

      // Best-effort namespace provisioning
      const provisionPaths = Object.values(ns);
      if (groupId !== undefined) {
        const groupNs = computeGroupNamespace(groupId as string);
        provisionPaths.push(groupNs.scratchpad);
      }
      // Best-effort provisioning — ensureNamespace already logs warnings
      try {
        await ensureNamespace(client, provisionPaths);
      } catch {
        // Swallow
      }

      const components = new Map<string, unknown>();
      const skipped: SkippedComponent[] = [];

      // ── Forge store ──
      const forgeOverride = agentOverrides.forge;
      const forgeStore = createNexusForgeStore({
        baseUrl,
        apiKey,
        basePath: ns.forge,
        ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
        ...(forgeOverride?.concurrency !== undefined
          ? { concurrency: forgeOverride.concurrency }
          : {}),
      });
      components.set("forge-store", forgeStore);

      // ── Event backend ──
      const events = createNexusEventBackend({
        baseUrl,
        apiKey,
        basePath: ns.events,
        ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
        ...(agentOverrides.events !== undefined ? agentOverrides.events : {}),
      });
      components.set(EVENTS as string, events);

      // ── Session persistence ──
      const session = createNexusSessionStore({
        baseUrl,
        apiKey,
        basePath: ns.session,
        ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
      });
      components.set("session-persistence", session);

      // ── Memory backend ──
      const memory = createNexusMemoryBackend({
        baseUrl,
        apiKey,
        basePath: ns.memory,
        ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
      });
      components.set(MEMORY as string, memory);

      // ── Snapshot store ──
      const snapshots = createNexusSnapshotStore({
        baseUrl,
        apiKey,
        basePath: ns.snapshots,
        ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
      });
      components.set("snapshot-store", snapshots);

      // ── Filesystem ──
      const filesystem = createNexusFileSystem({
        client,
        basePath: ns.filesystem,
      });
      components.set(FILESYSTEM as string, filesystem);

      // ── Mailbox ──
      const mbOverride = agentOverrides.mailbox;
      const mailbox = createNexusMailbox({
        agentId,
        baseUrl,
        authToken: apiKey,
        ...(mbOverride?.delivery !== undefined ? { delivery: mbOverride.delivery } : {}),
        ...(mbOverride?.seenCapacity !== undefined
          ? { seenCapacity: mbOverride.seenCapacity }
          : {}),
        ...(mbOverride?.pollMinMs !== undefined ? { pollMinMs: mbOverride.pollMinMs } : {}),
        ...(mbOverride?.pollMaxMs !== undefined ? { pollMaxMs: mbOverride.pollMaxMs } : {}),
      });
      components.set(MAILBOX as string, mailbox);

      // ── Workspace (opt-in) ──
      if (optIn.workspace !== undefined) {
        const wsResult = createNexusWorkspaceBackend({
          nexusUrl: baseUrl,
          apiKey,
          ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
          ...(optIn.workspace !== undefined ? optIn.workspace : {}),
        });
        if (wsResult.ok) {
          components.set(WORKSPACE as string, wsResult.value);
        } else {
          skipped.push({
            name: WORKSPACE as string,
            reason: wsResult.error.message,
          });
        }
      }

      // ── Scratchpad (group-scoped) ──
      let scratchpadMiddleware: KoiMiddleware | undefined;
      if (groupId !== undefined) {
        const scratchpad = createScratchpadNexusProvider({
          agentId,
          groupId,
          nexus: { baseUrl, apiKey, ...(fetchFn !== undefined ? { fetch: fetchFn } : {}) },
        });

        // Extract components from the scratchpad provider via its attach()
        const scratchpadResult = await scratchpad.provider.attach(agent);
        const scratchpadComponents =
          "components" in scratchpadResult ? scratchpadResult.components : scratchpadResult;
        for (const [key, value] of scratchpadComponents) {
          components.set(key, value);
        }
        scratchpadMiddleware = scratchpad.middleware;

        // Collect middleware (only add once across agents)
        if (!middlewares.some((mw) => mw.name === scratchpad.middleware.name)) {
          middlewares.push(scratchpad.middleware);
        }
      }

      // Track disposables
      disposalMap.set(agentIdStr, {
        mailbox: mailbox as unknown as Disposable,
        scratchpadMiddleware,
      });

      if (disposalMap.size > DISPOSAL_MAP_WARNING_THRESHOLD) {
        console.warn(
          `[nexus] disposal map has ${String(disposalMap.size)} entries — possible memory leak`,
        );
      }

      return { components, skipped };
    },

    async detach(agent: Agent): Promise<void> {
      const agentIdStr = agent.pid.id as string;
      const disposables = disposalMap.get(agentIdStr);
      if (disposables === undefined) return; // idempotent

      // Dispose mailbox if it implements Disposable
      if (disposables.mailbox !== undefined) {
        try {
          disposables.mailbox[Symbol.dispose]();
        } catch {
          // Best-effort cleanup
        }
      }

      disposalMap.delete(agentIdStr);
    },
  };

  return { provider, middlewares };
}
