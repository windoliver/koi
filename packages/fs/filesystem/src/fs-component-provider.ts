/**
 * FileSystem ComponentProvider — attaches filesystem Tool components to an agent.
 *
 * Both engine-claude and engine-pi discover tools via `agent.query<Tool>("tool:")`.
 * This provider creates Tool components from a FileSystemBackend, making them
 * available to any engine with zero engine changes.
 */

import type { ComponentProvider, FileSystemBackend, Tool, ToolPolicy } from "@koi/core";
import {
  createServiceProvider,
  DEFAULT_UNSANDBOXED_POLICY,
  FILESYSTEM,
  skillToken,
  toolToken,
} from "@koi/core";
import type { FileSystemScope } from "@koi/scope";
import { createScopedFileSystem } from "@koi/scope";
import type { Retriever } from "@koi/search-provider";
import type { FileSystemOperation } from "./constants.js";
import { createFsSkill, DEFAULT_PREFIX, FS_SKILL_NAME, OPERATIONS } from "./constants.js";
import { createFsEditTool } from "./tools/edit.js";
import { createFsListTool } from "./tools/list.js";
import { createFsReadTool } from "./tools/read.js";
import { createFsSearchTool } from "./tools/search.js";
import { createFsSemanticSearchTool } from "./tools/semantic-search.js";
import { createFsWriteTool } from "./tools/write.js";

export interface FileSystemProviderConfig {
  readonly backend: FileSystemBackend;
  readonly policy?: ToolPolicy;
  readonly prefix?: string;
  readonly operations?: readonly FileSystemOperation[];
  /**
   * Filesystem scope restriction. When set, the backend is wrapped in a
   * scoped proxy that enforces root path containment and read-only mode.
   */
  readonly scope?: FileSystemScope;
  /**
   * Optional semantic search retriever. When provided, an additional
   * `${prefix}_semantic_search` tool is registered alongside the standard tools.
   */
  readonly retriever?: Retriever | undefined;
}

const TOOL_FACTORIES: Readonly<
  Record<FileSystemOperation, (b: FileSystemBackend, p: string, t: ToolPolicy) => Tool>
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
    policy = DEFAULT_UNSANDBOXED_POLICY,
    prefix = DEFAULT_PREFIX,
    operations = OPERATIONS,
    scope,
    retriever,
  } = config;

  const backend = scope !== undefined ? createScopedFileSystem(rawBackend, scope) : rawBackend;
  const hasRetriever = retriever !== undefined;
  const skill = createFsSkill(hasRetriever);

  return createServiceProvider({
    name: `filesystem:${backend.name}`,
    singletonToken: FILESYSTEM,
    backend,
    operations,
    factories: TOOL_FACTORIES,
    policy,
    prefix,
    customTools: (_backend, _agent) => {
      const skillEntry: readonly [string, unknown] = [skillToken(FS_SKILL_NAME) as string, skill];
      if (retriever === undefined) {
        return [skillEntry];
      }
      const semanticTool = createFsSemanticSearchTool(retriever, prefix, policy);
      return [skillEntry, [toolToken(semanticTool.descriptor.name) as string, semanticTool]];
    },
    detach: async (b) => {
      if (b.dispose) {
        await b.dispose();
      }
    },
  });
}
