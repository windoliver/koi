/**
 * Agent spawner factory — runs coding agents inside sandboxed containers.
 *
 * Each spawn creates a fresh SandboxInstance for isolation. Active instances
 * are tracked for cleanup on dispose().
 */

import type {
  ExternalAgentDescriptor,
  KoiError,
  Result,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { createLineReader } from "@koi/sandbox-cloud-base";
import {
  buildAcpArgs,
  buildAcpStdin,
  buildStdioArgs,
  DEFAULT_TIMEOUT_MS,
  extractAcpOutput,
  parseStdioOutput,
} from "./delegation-protocol.js";
import { createSemaphore } from "./semaphore.js";
import type { AgentSpawner, AgentSpawnerConfig, SpawnOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an AgentSpawner that runs coding agents inside sandbox containers.
 *
 * Each spawn() call creates a fresh SandboxInstance for per-agent isolation.
 * Callers may pass a manifest-derived profile via SpawnOptions.profile.
 */
export function createAgentSpawner(config: AgentSpawnerConfig): AgentSpawner {
  const maxConcurrent = config.maxConcurrentDelegations ?? DEFAULT_MAX_CONCURRENT;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const semaphore = createSemaphore(maxConcurrent);

  // Default profile — used when SpawnOptions.profile is not provided
  const filesystem: SandboxProfile["filesystem"] =
    config.cwd !== undefined
      ? { allowRead: [config.cwd], allowWrite: [config.cwd, "/tmp"] }
      : { allowWrite: ["/tmp"] };

  const defaultProfile: SandboxProfile = {
    filesystem,
    network: { allow: true },
    resources: {
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    ...(config.env !== undefined ? { env: config.env } : {}),
  };

  // let: mutable state
  let disposed = false;
  const activeInstances = new Set<SandboxInstance>();

  async function spawnImpl(
    agent: ExternalAgentDescriptor,
    prompt: string,
    options?: SpawnOptions,
  ): Promise<Result<string, KoiError>> {
    if (disposed) {
      throw new Error("AgentSpawner has been disposed");
    }

    if (agent.command === undefined || agent.command.length === 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Agent "${agent.name}" has no command configured`,
          retryable: false,
          context: { agentName: agent.name },
        },
      };
    }

    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const protocol = agent.protocol ?? "stdio";
    const spawnProfile = options?.profile ?? defaultProfile;

    // Per-spawn instance — fresh sandbox for each agent
    const inst = await config.adapter.create(spawnProfile);
    activeInstances.add(inst);

    try {
      if (protocol === "acp") {
        // Use interactive spawn() when available for bidirectional ACP
        if (inst.spawn !== undefined) {
          return await spawnAcpInteractive(inst, agent.command, prompt, options?.model, timeoutMs);
        }
        return await spawnAcp(inst, agent.command, prompt, options?.model, timeoutMs);
      }
      return await spawnStdio(inst, agent.command, prompt, options?.model, timeoutMs);
    } finally {
      activeInstances.delete(inst);
      await inst.destroy();
    }
  }

  async function spawnStdio(
    inst: SandboxInstance,
    command: string,
    prompt: string,
    model: string | undefined,
    timeoutMs: number,
  ): Promise<Result<string, KoiError>> {
    const args = buildStdioArgs(command, prompt, model);
    const [cmd, ...rest] = args;
    if (cmd === undefined) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Empty command arguments",
          retryable: false,
        },
      };
    }

    const result = await inst.exec(cmd, rest, {
      timeoutMs,
      maxOutputBytes,
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    });

    return parseStdioOutput(result);
  }

  async function spawnAcp(
    inst: SandboxInstance,
    command: string,
    prompt: string,
    model: string | undefined,
    timeoutMs: number,
  ): Promise<Result<string, KoiError>> {
    const args = buildAcpArgs(command, model);
    const [cmd, ...rest] = args;
    if (cmd === undefined) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Empty command arguments",
          retryable: false,
        },
      };
    }

    const stdin = buildAcpStdin(prompt);

    const result = await inst.exec(cmd, rest, {
      timeoutMs,
      stdin,
      maxOutputBytes,
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    });

    if (result.timedOut) {
      return {
        ok: false,
        error: {
          code: "TIMEOUT",
          message: "ACP agent timed out",
          retryable: true,
          context: { kind: "TIMEOUT" },
        },
      };
    }

    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `ACP agent exited with code ${String(result.exitCode)}: ${result.stderr.slice(0, 500)}`,
          retryable: true,
          context: { kind: "SPAWN_FAILED", exitCode: result.exitCode },
        },
      };
    }

    return extractAcpOutput(result.stdout);
  }

  /**
   * Interactive ACP path — uses spawn() for bidirectional stdin/stdout.
   *
   * Writes ACP JSON-RPC requests to stdin, reads NDJSON responses via
   * createLineReader with backpressure caps, then parses with extractAcpOutput.
   */
  async function spawnAcpInteractive(
    inst: SandboxInstance,
    command: string,
    prompt: string,
    model: string | undefined,
    timeoutMs: number,
  ): Promise<Result<string, KoiError>> {
    const args = buildAcpArgs(command, model);
    const [cmd, ...rest] = args;
    if (cmd === undefined) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Empty command arguments",
          retryable: false,
        },
      };
    }

    if (inst.spawn === undefined) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Sandbox instance does not support interactive spawn",
          retryable: false,
        },
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const handle = await inst.spawn(cmd, rest, {
        signal: controller.signal,
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      });

      // Send ACP requests
      const stdinData = buildAcpStdin(prompt);
      handle.stdin.write(stdinData);
      handle.stdin.end();

      // Read NDJSON responses — accumulate with byte cap
      // let: local accumulator for streaming reads
      let totalBytes = 0;
      const lines: string[] = [];
      for await (const line of createLineReader(handle.stdout)) {
        totalBytes += line.length;
        if (totalBytes > maxOutputBytes) {
          handle.kill();
          break;
        }
        lines.push(line);
      }

      const exitCode = await handle.exited;
      clearTimeout(timeout);

      if (exitCode !== 0) {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `ACP agent exited with code ${String(exitCode)}`,
            retryable: true,
            context: { kind: "SPAWN_FAILED", exitCode },
          },
        };
      }

      return extractAcpOutput(`${lines.join("\n")}\n`);
    } catch (e: unknown) {
      clearTimeout(timeout);

      if (controller.signal.aborted) {
        return {
          ok: false,
          error: {
            code: "TIMEOUT",
            message: "ACP agent timed out",
            retryable: true,
            context: { kind: "TIMEOUT" },
          },
        };
      }

      throw e;
    }
  }

  return {
    spawn: async (
      agent: ExternalAgentDescriptor,
      prompt: string,
      options?: SpawnOptions,
    ): Promise<Result<string, KoiError>> => {
      await semaphore.acquire();
      try {
        return await spawnImpl(agent, prompt, options);
      } catch (e: unknown) {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: e instanceof Error ? e.message : String(e),
            retryable: true,
            cause: e,
            context: { kind: "SPAWN_FAILED", agentName: agent.name },
          },
        };
      } finally {
        semaphore.release();
      }
    },

    dispose: async (): Promise<void> => {
      disposed = true;
      // Destroy all active instances
      const instances = [...activeInstances];
      activeInstances.clear();
      await Promise.all(instances.map((inst) => inst.destroy()));
    },
  };
}
