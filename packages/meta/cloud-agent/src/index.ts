import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  ApprovalHandler,
  FileSystemBackend,
  ModelAdapter,
  SandboxExecutor,
  SandboxExecutorCapabilities,
} from "@koi/core";
import { createKoiRuntime, type KoiRuntimeHandle } from "@koi-agent/cli";

export interface CloudRuntimeConfig {
  readonly modelAdapter: ModelAdapter;
  readonly modelName: string;
  readonly approvalHandler: ApprovalHandler;
  readonly sandboxExecutor: CloudSandboxExecutor;
  readonly filesystem: FileSystemBackend;
  readonly cwd?: string | undefined;
  /**
   * Approved tenant-local root for sandbox workspace mounts. Defaults to cwd
   * when cwd is provided. Required when sandboxWorkspacePath is provided.
   */
  readonly sandboxWorkspaceRoot?: string | undefined;
  /**
   * Explicit local mount path shared by the injected filesystem backend and
   * the sandbox. Omit to keep execute_script hidden for virtual backends.
   */
  readonly sandboxWorkspacePath?: string | undefined;
}

export interface CloudSandboxExecutor extends SandboxExecutor {
  readonly sandboxCapabilities: SandboxExecutorCapabilities;
}

export interface CloudRuntimeHandle extends KoiRuntimeHandle {
  readonly sandboxRequired: true;
}

function assertSandboxCapabilities(executor: CloudSandboxExecutor): void {
  const capabilities = executor.sandboxCapabilities;
  if (
    capabilities === undefined ||
    capabilities.network !== "enforced" ||
    capabilities.resources !== "enforced" ||
    capabilities.filesystem !== "enforced" ||
    capabilities.process !== "enforced"
  ) {
    throw new Error(
      "cloud sandbox executor must expose enforced network, resource, filesystem, and process capabilities",
    );
  }
}

function assertContainedPath(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!isAbsolute(root) || !isAbsolute(candidate)) {
    throw new Error(
      "sandboxWorkspacePath must be contained within the approved sandbox workspace root",
    );
  }
  const canonicalRoot = realpathSync(resolvedRoot);
  const canonicalCandidate = realpathSync(resolvedCandidate);
  const rel = relative(canonicalRoot, canonicalCandidate);
  if (
    rel === ".." ||
    rel.startsWith(`..${"/"}`) ||
    rel.startsWith(`..${"\\"}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(
      "sandboxWorkspacePath must be contained within the approved sandbox workspace root",
    );
  }
  return canonicalCandidate;
}

function resolveSandboxWorkspacePath(config: CloudRuntimeConfig): string | undefined {
  if (config.sandboxWorkspacePath === undefined) return undefined;
  const root = config.sandboxWorkspaceRoot ?? config.cwd;
  if (root === undefined) {
    throw new Error(
      "sandboxWorkspaceRoot or cwd is required when sandboxWorkspacePath is provided",
    );
  }
  return assertContainedPath(root, config.sandboxWorkspacePath);
}

export async function createCloudRuntime(config: CloudRuntimeConfig): Promise<CloudRuntimeHandle> {
  assertSandboxCapabilities(config.sandboxExecutor);
  const sandboxWorkspacePath = resolveSandboxWorkspacePath(config);
  const handle = await createKoiRuntime({
    modelAdapter: config.modelAdapter,
    modelName: config.modelName,
    approvalHandler: config.approvalHandler,
    stacks: [],
    plugins: [],
    disableUserHooks: true,
    backgroundSubprocesses: false,
    includeFilesystemTools: false,
    includeWebFetch: false,
    includeBuiltinSearch: false,
    sandboxExecutor: config.sandboxExecutor,
    sandboxEnforcementRequired: true,
    filesystem: config.filesystem,
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(sandboxWorkspacePath !== undefined
      ? { codeExecutionWorkspacePath: sandboxWorkspacePath }
      : {}),
  });
  return {
    ...handle,
    sandboxRequired: true,
  };
}
