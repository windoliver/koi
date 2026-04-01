/**
 * Nexus FUSE mount helper — mounts Nexus virtual filesystem inside a cloud sandbox.
 *
 * Executes `nexus-fuse mount` post-creation for each configured mount point.
 * The binary must be pre-installed in the sandbox image.
 */

import type { NexusFuseMount, SandboxInstance } from "@koi/core";

const MOUNT_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 5_000;

/**
 * Mount Nexus FUSE filesystems inside a sandbox instance.
 *
 * For each mount:
 * 1. Creates the mount point directory
 * 2. Runs `nexus-fuse mount` (daemonizes and returns immediately)
 * 3. Verifies the mount is accessible via `ls`
 */
export async function mountNexusFuse(
  instance: SandboxInstance,
  mounts: readonly NexusFuseMount[],
): Promise<void> {
  for (const mount of mounts) {
    // Validate inputs at system boundary
    if (
      mount.mountPath === "" ||
      !mount.mountPath.startsWith("/") ||
      mount.mountPath.includes("..")
    ) {
      throw new Error(
        `Invalid mount path "${mount.mountPath}": must be absolute and must not contain ".."`,
      );
    }
    if (mount.nexusUrl === "") {
      throw new Error("NexusFuseMount nexusUrl must not be empty");
    }
    if (mount.apiKey === "") {
      throw new Error("NexusFuseMount apiKey must not be empty");
    }

    // 1. Create mount point
    const mkdirResult = await instance.exec("mkdir", ["-p", mount.mountPath], {
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    if (mkdirResult.exitCode !== 0) {
      throw new Error(`Failed to create mount point ${mount.mountPath}: ${mkdirResult.stderr}`);
    }

    // 2. Mount via nexus-fuse
    const baseArgs = ["mount", mount.mountPath, "--url", mount.nexusUrl, "--api-key", mount.apiKey];
    const mountArgs =
      mount.agentId !== undefined ? [...baseArgs, "--agent-id", mount.agentId] : baseArgs;

    const mountResult = await instance.exec("nexus-fuse", mountArgs, {
      timeoutMs: MOUNT_TIMEOUT_MS,
    });
    if (mountResult.exitCode !== 0) {
      throw new Error(`nexus-fuse mount failed for ${mount.mountPath}: ${mountResult.stderr}`);
    }

    // 3. Verify mount is accessible
    const verifyResult = await instance.exec("ls", [mount.mountPath], {
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    if (verifyResult.exitCode !== 0) {
      throw new Error(
        `Nexus FUSE mount verification failed for ${mount.mountPath}: ${verifyResult.stderr}`,
      );
    }
  }
}
