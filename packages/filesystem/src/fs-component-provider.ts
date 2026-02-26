/**
 * FileSystem ComponentProvider — attaches filesystem Tool components to an agent.
 *
 * Both engine-claude and engine-pi discover tools via `agent.query<Tool>("tool:")`.
 * This provider creates Tool components from a FileSystemBackend, making them
 * available to any engine with zero engine changes.
 */

import type { Agent, ComponentProvider, FileSystemBackend, Tool, TrustTier } from "@koi/core";
import { FILESYSTEM, toolToken } from "@koi/core";
import type { FileSystemScope } from "@koi/scope";
import { createScopedFileSystem } from "@koi/scope";
import type { FileSystemOperation } from "./constants.js";
import { DEFAULT_PREFIX, OPERATIONS } from "./constants.js";
import { createFsEditTool } from "./tools/edit.js";
import { createFsListTool } from "./tools/list.js";
import { createFsReadTool } from "./tools/read.js";
import { createFsSearchTool } from "./tools/search.js";
import { createFsWriteTool } from "./tools/write.js";

export interface FileSystemProviderConfig {
  readonly backend: FileSystemBackend;
  readonly trustTier?: TrustTier;
  readonly prefix?: string;
  readonly operations?: readonly FileSystemOperation[];
  /**
   * Filesystem scope restriction. When set, the backend is wrapped in a
   * scoped proxy that enforces root path containment and read-only mode.
   */
  readonly scope?: FileSystemScope;
}

const TOOL_FACTORIES: Readonly<
  Record<FileSystemOperation, (b: FileSystemBackend, p: string, t: TrustTier) => Tool>
> = {
  read: createFsReadTool,
  write: createFsWriteTool,
  edit: createFsEditTool,
  list: createFsListTool,
  search: createFsSearchTool,
};

export function createFileSystemProvider(config: FileSystemProviderConfig): ComponentProvider {
  const {
    backend: rawBackend,
    trustTier = "verified",
    prefix = DEFAULT_PREFIX,
    operations = OPERATIONS,
    scope,
  } = config;

  const backend = scope !== undefined ? createScopedFileSystem(rawBackend, scope) : rawBackend;

  return {
    name: `filesystem:${backend.name}`,

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const toolEntries = operations.map((op) => {
        const factory = TOOL_FACTORIES[op];
        const tool = factory(backend, prefix, trustTier);
        return [toolToken(tool.descriptor.name) as string, tool] as const;
      });

      return new Map<string, unknown>([[FILESYSTEM as string, backend], ...toolEntries]);
    },

    detach: async (_agent: Agent): Promise<void> => {
      if (backend.dispose) {
        await backend.dispose();
      }
    },
  };
}
