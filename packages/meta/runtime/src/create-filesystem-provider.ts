/**
 * Filesystem ComponentProvider factory — wires a FileSystemBackend into the
 * ECS assembly with the FILESYSTEM singleton token and fs_read/fs_write/fs_edit tools.
 *
 * Uses createServiceProvider (L0) so the backend and tools are discoverable
 * via agent.component(FILESYSTEM) and agent.query<Tool>("tool:").
 */

import type {
  ComponentProvider,
  FileSystemBackend,
  Tool,
  ToolDescriptor,
  ToolResponse,
} from "@koi/core";
import { createServiceProvider, DEFAULT_UNSANDBOXED_POLICY, FILESYSTEM } from "@koi/core";
import { createFsEditTool, createFsReadTool, createFsWriteTool } from "@koi/tools-builtin";

/** Filesystem operations exposed as tools. */
type FsOperation = "read" | "write" | "edit";

const _FS_OPERATIONS: readonly FsOperation[] = ["read", "write", "edit"] as const;

const FS_TOOL_FACTORIES: Readonly<
  Record<
    FsOperation,
    (
      backend: FileSystemBackend,
      prefix: string,
      policy: import("@koi/core").ToolPolicy,
    ) => import("@koi/core").Tool
  >
> = {
  read: createFsReadTool,
  write: createFsWriteTool,
  edit: createFsEditTool,
} as const;

/** Resolved filesystem tools — both instances (for execution) and descriptors (for advertisement). */
export interface FileSystemTools {
  readonly tools: ReadonlyMap<string, Tool>;
  readonly descriptors: readonly ToolDescriptor[];
}

/**
 * Create filesystem tool instances and their descriptors.
 *
 * Returns both the executable Tool objects (keyed by name for dispatch)
 * and their descriptors (for advertisement in callHandlers.tools).
 */
/**
 * Default: read-only. Write/edit require explicit opt-in to prevent
 * accidental mutation grants when enabling filesystem.
 */
const DEFAULT_FS_OPERATIONS: readonly FsOperation[] = ["read"] as const;

export function createFileSystemTools(
  backend: FileSystemBackend,
  prefix = "fs",
  operations: readonly FsOperation[] = DEFAULT_FS_OPERATIONS,
): FileSystemTools {
  const policy = DEFAULT_UNSANDBOXED_POLICY;
  const toolInstances = operations.map((op) => FS_TOOL_FACTORIES[op](backend, prefix, policy));
  const tools = new Map(toolInstances.map((t) => [t.descriptor.name, t]));
  const descriptors = toolInstances.map((t) => t.descriptor);
  return { tools, descriptors };
}

/**
 * Create a toolCall handler that dispatches to registered tools by name.
 *
 * Used by createRuntime() to wire fs tools (and optionally other tools)
 * into the adapter's tool execution path. Falls through to a delegate
 * handler for tools not in the registry.
 */
export function createToolDispatcher(
  tools: ReadonlyMap<string, Tool>,
  delegate?: (request: import("@koi/core").ToolRequest) => Promise<ToolResponse>,
): (request: import("@koi/core").ToolRequest) => Promise<ToolResponse> {
  return async (request) => {
    const tool = tools.get(request.toolId);
    if (tool !== undefined) {
      const output = await tool.execute(
        request.input as import("@koi/core").JsonObject,
        request.signal !== undefined ? { signal: request.signal } : undefined,
      );
      return { toolId: request.toolId, output };
    }
    if (delegate !== undefined) {
      return delegate(request);
    }
    // Fail closed: unknown tools throw instead of returning a soft error.
    // This preserves the runtime's existing defaultToolHandler behavior
    // so misconfigured tool advertisements are caught immediately.
    throw new Error(
      `No handler for tool "${request.toolId}". ` +
        "Tool is advertised but has no backing execution handler.",
    );
  };
}

/**
 * Create a ComponentProvider that attaches a FileSystemBackend under the
 * FILESYSTEM token and registers fs_read, fs_write, fs_edit tools.
 *
 * @param backend - Resolved FileSystemBackend (local or nexus).
 * @param prefix - Tool name prefix. Default: "fs" (produces fs_read, fs_write, fs_edit).
 */
export function createFileSystemProvider(
  backend: FileSystemBackend,
  prefix = "fs",
  operations: readonly FsOperation[] = DEFAULT_FS_OPERATIONS,
): ComponentProvider {
  return createServiceProvider<FileSystemBackend, FsOperation>({
    name: `filesystem:${backend.name}`,
    singletonToken: FILESYSTEM,
    backend,
    operations,
    factories: FS_TOOL_FACTORIES,
    prefix,
    detach: async (b) => {
      await b.dispose?.();
    },
  });
}
