/**
 * Declarative procfs entry definitions — data-driven introspection layer.
 *
 * Each definition describes a procfs entry as a pure data object with
 * read/write/list callbacks. The entry factory creates ProcEntry instances
 * from these definitions, and the agent mounter iterates over them.
 *
 * Adding a new entry = adding one object to PROCFS_ENTRIES.
 */

import type {
  Agent,
  AgentEnv,
  AgentId,
  AgentRegistry,
  KoiMiddleware,
  MailboxComponent,
  ScratchpadComponent,
  Tool,
  WorkspaceComponent,
} from "@koi/core";
import { AGENT_SIGNALS, ENV, MAILBOX, SCRATCHPAD, WORKSPACE } from "@koi/core";

// ---------------------------------------------------------------------------
// Entry context — passed to all callbacks
// ---------------------------------------------------------------------------

export interface EntryContext {
  readonly agent: Agent;
  readonly agentId: AgentId;
  readonly registry: AgentRegistry;
}

// ---------------------------------------------------------------------------
// Entry definition — declarative entry descriptor
// ---------------------------------------------------------------------------

export interface EntryDefinition {
  readonly path: string;
  readonly read: (ctx: EntryContext) => unknown | Promise<unknown>;
  readonly write?: (ctx: EntryContext, value: unknown) => void | Promise<void>;
  readonly list?: (ctx: EntryContext) => readonly string[] | Promise<readonly string[]>;
}

// ---------------------------------------------------------------------------
// Entry definitions — 12 entries
// ---------------------------------------------------------------------------

export const PROCFS_ENTRIES: readonly EntryDefinition[] = [
  // ---- Core entries ----

  {
    path: "status",
    read: (ctx) => ({
      pid: ctx.agent.pid,
      state: ctx.agent.state,
      terminationOutcome: ctx.agent.terminationOutcome,
    }),
  },

  {
    path: "metrics",
    read: async (ctx) => {
      const entry = await ctx.registry.lookup(ctx.agentId);
      if (entry === undefined) return undefined;
      return {
        priority: entry.priority,
        generation: entry.status.generation,
        phase: entry.status.phase,
        conditions: entry.status.conditions,
        registeredAt: entry.registeredAt,
      };
    },
    write: async (ctx, value) => {
      if (typeof value === "object" && value !== null && "priority" in value) {
        const priority = (value as Readonly<Record<string, unknown>>).priority;
        if (typeof priority === "number") {
          await ctx.registry.patch(ctx.agentId, { priority });
        }
      }
    },
  },

  {
    path: "tools",
    read: (ctx) => {
      const tools = ctx.agent.query<Tool>("tool:");
      return [...tools.entries()].map(([token, tool]) => ({
        token: token as string,
        name: tool.descriptor.name,
        description: tool.descriptor.description,
        policy: tool.policy,
      }));
    },
    list: (ctx) => {
      const tools = ctx.agent.query<Tool>("tool:");
      return [...tools.keys()].map((t) => t as string);
    },
  },

  {
    path: "middleware",
    read: (ctx) => {
      const mw = ctx.agent.query<KoiMiddleware>("middleware:");
      return [...mw.entries()].map(([token, middleware]) => ({
        token: token as string,
        name: middleware.name,
      }));
    },
    list: (ctx) => {
      const mw = ctx.agent.query<KoiMiddleware>("middleware:");
      return [...mw.keys()].map((t) => t as string);
    },
  },

  {
    path: "children",
    read: async (ctx) => {
      const children = await ctx.registry.list({ parentId: ctx.agentId });
      return children.map((entry) => ({
        agentId: entry.agentId,
        agentType: entry.agentType,
        phase: entry.status.phase,
        priority: entry.priority,
      }));
    },
    list: async (ctx) => {
      const children = await ctx.registry.list({ parentId: ctx.agentId });
      return children.map((entry) => entry.agentId as string);
    },
  },

  {
    path: "config",
    read: (ctx) => ({
      name: ctx.agent.manifest.name,
      description: ctx.agent.manifest.description,
      model: ctx.agent.manifest.model,
      lifecycle: ctx.agent.manifest.lifecycle,
    }),
  },

  {
    path: "env",
    read: (ctx) => {
      const env = ctx.agent.component<AgentEnv>(ENV);
      if (env === undefined) return {};
      return { ...env.values };
    },
    list: (ctx) => {
      const env = ctx.agent.component<AgentEnv>(ENV);
      if (env === undefined) return [];
      return Object.keys(env.values);
    },
  },

  // ---- Extended entries ----

  {
    path: "descriptor",
    read: async (ctx) => {
      if (ctx.registry.descriptor !== undefined) {
        return ctx.registry.descriptor(ctx.agentId);
      }
      // Fallback: lookup entry and return minimal descriptor shape
      const entry = await ctx.registry.lookup(ctx.agentId);
      if (entry === undefined) return undefined;
      return {
        agentId: entry.agentId,
        state: entry.status.phase,
        conditions: entry.status.conditions,
        generation: entry.status.generation,
        registeredAt: entry.registeredAt,
      };
    },
  },

  {
    path: "signals",
    read: () => AGENT_SIGNALS,
  },

  {
    path: "mailbox",
    read: async (ctx) => {
      const mailbox = ctx.agent.component<MailboxComponent>(MAILBOX);
      if (mailbox === undefined) return undefined;
      return mailbox.list();
    },
  },

  {
    path: "scratchpad",
    read: async (ctx) => {
      const scratchpad = ctx.agent.component<ScratchpadComponent>(SCRATCHPAD);
      if (scratchpad === undefined) return undefined;
      return scratchpad.list();
    },
  },

  {
    path: "workspace",
    read: (ctx) => {
      const workspace = ctx.agent.component<WorkspaceComponent>(WORKSPACE);
      if (workspace === undefined) return undefined;
      return {
        id: workspace.id,
        path: workspace.path,
        createdAt: workspace.createdAt,
        metadata: workspace.metadata,
      };
    },
  },
];
