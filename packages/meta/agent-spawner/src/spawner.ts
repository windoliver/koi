/**
 * Agent spawner factory — runs coding agents inside sandboxed containers.
 */

import type {
  ExternalAgentDescriptor,
  KoiError,
  Result,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
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
const DEFAULT_IDLE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an AgentSpawner that runs coding agents inside sandbox containers.
 */
export function createAgentSpawner(config: AgentSpawnerConfig): AgentSpawner {
  const maxConcurrent = config.maxConcurrentDelegations ?? DEFAULT_MAX_CONCURRENT;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const idleTtlMs = config.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;

  const semaphore = createSemaphore(maxConcurrent);

  const filesystem: SandboxProfile["filesystem"] =
    config.cwd !== undefined
      ? { allowRead: [config.cwd], allowWrite: [config.cwd, "/tmp"] }
      : { allowWrite: ["/tmp"] };

  const profile: SandboxProfile = {
    tier: "sandbox",
    filesystem,
    network: { allow: true },
    resources: {
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    ...(config.env !== undefined ? { env: config.env } : {}),
  };

  // let: mutable instance state for reuse across calls
  let instance: SandboxInstance | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function resetIdleTimer(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      void destroyInstance();
    }, idleTtlMs);
  }

  async function ensureInstance(): Promise<SandboxInstance> {
    if (disposed) {
      throw new Error("AgentSpawner has been disposed");
    }
    if (instance === undefined) {
      instance = await config.adapter.create(profile);
    }
    resetIdleTimer();
    return instance;
  }

  async function destroyInstance(): Promise<void> {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (instance !== undefined) {
      const toDestroy = instance;
      instance = undefined;
      await toDestroy.destroy();
    }
  }

  async function spawnImpl(
    agent: ExternalAgentDescriptor,
    prompt: string,
    options?: SpawnOptions,
  ): Promise<Result<string, KoiError>> {
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

    const inst = await ensureInstance();

    if (protocol === "acp") {
      return spawnAcp(inst, agent.command, prompt, options?.model, timeoutMs);
    }
    return spawnStdio(inst, agent.command, prompt, options?.model, timeoutMs);
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
      await destroyInstance();
    },
  };
}
