#!/usr/bin/env bun
/**
 * E2E test script for cloud/container sandbox adapters.
 *
 * Three stages:
 *   Stage 1: E2B — Full lifecycle (create → exec → file roundtrip → destroy)
 *   Stage 2: Vercel — Full lifecycle (same test matrix)
 *   Stage 3: Docker — Full lifecycle via Docker CLI (requires Docker daemon)
 *
 * Cloudflare is excluded — its SDK requires Durable Object bindings
 * and can only run inside a deployed Cloudflare Worker.
 *
 * Usage:
 *   E2B_API_KEY=... bun scripts/e2e-sandbox-cloud.ts                    # E2B only
 *   E2B_API_KEY=... VERCEL_TOKEN=... bun scripts/e2e-sandbox-cloud.ts   # E2B + Vercel
 *   DOCKER_INTEGRATION=1 bun scripts/e2e-sandbox-cloud.ts               # Docker only
 *
 * Env vars:
 *   E2B_API_KEY       — E2B API key
 *   VERCEL_TOKEN      — Vercel personal access token (or VERCEL_ACCESS_TOKEN)
 *   VERCEL_TEAM_ID    — Vercel team ID
 *   VERCEL_PROJECT_ID — Vercel project ID
 *   DOCKER_INTEGRATION — Set to "1" to run Docker stage (requires Docker daemon)
 */

// ---------------------------------------------------------------------------
// Imports (direct from source — Bun runs .ts natively)
// ---------------------------------------------------------------------------

import type { SandboxInstance } from "../packages/core/src/index.js";
import { createDockerAdapter } from "../packages/sandbox-docker/src/adapter.js";
import type {
  DockerClient,
  DockerContainer,
  DockerCreateOpts,
} from "../packages/sandbox-docker/src/types.js";
import { createE2bAdapter } from "../packages/sandbox-e2b/src/adapter.js";
import type { E2bClient, E2bCreateOpts, E2bSdkSandbox } from "../packages/sandbox-e2b/src/types.js";
import { createVercelAdapter } from "../packages/sandbox-vercel/src/adapter.js";
import type {
  VercelClient,
  VercelCreateOpts,
  VercelSdkSandbox,
} from "../packages/sandbox-vercel/src/types.js";

// ---------------------------------------------------------------------------
// Test harness (same pattern as e2e-sandbox-wasm.ts)
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail?: string): void {
  results.push({ name, passed: condition, detail });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  const suffix = detail && !condition ? ` (${detail})` : "";
  console.log(`  ${tag}  ${name}${suffix}`);
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  // let: mutable timer handle for cleanup — justified in E2E harness
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Shared constants and test suite
// ---------------------------------------------------------------------------

const TEST_PROFILE = {
  tier: "sandbox" as const,
  filesystem: { allowRead: ["/"], allowWrite: ["/tmp"] },
  network: { allow: false },
  resources: { timeoutMs: 60_000 },
} as const;

const SDK_CREATION_TIMEOUT_MS = 120_000;

async function runInstanceTests(instance: SandboxInstance, label: string): Promise<void> {
  // 1. Simple command
  const r1 = await withTimeout(
    () => instance.exec("echo", ["hello"], { timeoutMs: 10_000 }),
    15_000,
    `${label} echo`,
  );
  assert(`${label}: echo hello exits 0`, r1.exitCode === 0);
  assert(`${label}: echo hello stdout`, r1.stdout.trim() === "hello", `got: "${r1.stdout.trim()}"`);

  // 2. OS info
  const r2 = await withTimeout(
    () => instance.exec("cat", ["/etc/os-release"], { timeoutMs: 10_000 }),
    15_000,
    `${label} cat os-release`,
  );
  assert(`${label}: cat /etc/os-release exits 0`, r2.exitCode === 0);
  assert(`${label}: os-release has content`, r2.stdout.length > 0);

  // 3. File roundtrip
  const testContent = `Hello from Koi E2E test — ${Date.now()}`;
  const testPath = "/tmp/koi-e2e-test.txt";
  await withTimeout(
    () => instance.writeFile(testPath, new TextEncoder().encode(testContent)),
    10_000,
    `${label} writeFile`,
  );
  const readBack = await withTimeout(
    () => instance.readFile(testPath),
    10_000,
    `${label} readFile`,
  );
  const decoded = new TextDecoder().decode(readBack);
  assert(
    `${label}: file roundtrip preserves content`,
    decoded === testContent,
    `got: "${decoded}"`,
  );

  // 4. Non-zero exit code
  const r3 = await withTimeout(
    () => instance.exec("false", [], { timeoutMs: 10_000 }),
    15_000,
    `${label} false`,
  );
  assert(`${label}: 'false' returns non-zero exit`, r3.exitCode !== 0);

  // 5. Stderr capture — use single command string since adapter joins args
  // into a flat string, which breaks `sh -c` argument parsing
  const r4 = await withTimeout(
    () => instance.exec("echo error >&2", [], { timeoutMs: 10_000 }),
    15_000,
    `${label} stderr`,
  );
  assert(`${label}: stderr captured`, r4.stderr.trim() === "error", `got: "${r4.stderr.trim()}"`);

  // 6. Duration tracking
  assert(`${label}: durationMs > 0`, r1.durationMs > 0, `durationMs=${r1.durationMs}`);
}

// ---------------------------------------------------------------------------
// Stage 1: E2B
// ---------------------------------------------------------------------------

async function stage1(): Promise<void> {
  console.log("\n[stage 1] E2B cloud sandbox — full lifecycle\n");

  const apiKey = process.env.E2B_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    console.log("  \x1b[33mSKIP\x1b[0m  E2B_API_KEY not set\n");
    return;
  }

  // Dynamic import of real SDK (root devDependency, not in adapter package)
  const { Sandbox } = await import("e2b");

  // Thin wrapper: real E2B SDK → E2bClient interface
  const client: E2bClient = {
    createSandbox: async (opts: E2bCreateOpts): Promise<E2bSdkSandbox> => {
      const sdk = await Sandbox.create(opts.template ?? "base", {
        apiKey: opts.apiKey,
        timeoutMs: SDK_CREATION_TIMEOUT_MS,
      });

      return {
        commands: {
          run: async (cmd, execOpts) => {
            const result = await sdk.commands.run(cmd, {
              cwd: execOpts?.cwd,
              envs: execOpts?.envs,
              timeoutMs: execOpts?.timeoutMs,
              onStdout: execOpts?.onStdout,
              onStderr: execOpts?.onStderr,
            });
            return {
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            };
          },
        },
        files: {
          read: async (path: string): Promise<string> => {
            // E2B SDK files.read() returns string by default (text format)
            const data = await sdk.files.read(path);
            if (typeof data !== "string") {
              throw new Error(`E2B files.read returned unexpected type: ${typeof data}`);
            }
            return data;
          },
          write: async (path: string, content: string): Promise<void> => {
            // E2B SDK files.write() accepts string directly
            await sdk.files.write(path, content);
          },
        },
        kill: async (): Promise<void> => {
          await sdk.kill();
        },
      };
    },
  };

  // Create adapter using the real SDK client
  const adapterResult = createE2bAdapter({ apiKey, client });
  assert("E2B adapter created", adapterResult.ok);
  if (!adapterResult.ok) {
    console.log(`  Detail: ${adapterResult.error.message}\n`);
    return;
  }

  const adapter = adapterResult.value;

  console.log("  Creating E2B sandbox...");
  const instance = await withTimeout(
    () => adapter.create(TEST_PROFILE),
    60_000,
    "E2B sandbox creation",
  );
  assert("E2B sandbox instance created", instance !== undefined);

  try {
    await runInstanceTests(instance, "E2B");
  } finally {
    console.log("  Destroying E2B sandbox...");
    await withTimeout(() => instance.destroy(), 15_000, "E2B sandbox destroy");
    assert("E2B sandbox destroyed", true);
  }
}

// ---------------------------------------------------------------------------
// Stage 2: Vercel
// ---------------------------------------------------------------------------

async function stage2(): Promise<void> {
  console.log("\n[stage 2] Vercel cloud sandbox — full lifecycle\n");

  const apiToken = process.env.VERCEL_TOKEN ?? process.env.VERCEL_ACCESS_TOKEN;
  if (apiToken === undefined || apiToken === "") {
    console.log("  \x1b[33mSKIP\x1b[0m  VERCEL_TOKEN not set\n");
    return;
  }

  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;

  // Dynamic import of real SDK (root devDependency, not in adapter package)
  const { Sandbox } = await import("@vercel/sandbox");

  // Thin wrapper: real Vercel SDK → VercelClient interface
  const client: VercelClient = {
    createSandbox: async (opts: VercelCreateOpts): Promise<VercelSdkSandbox> => {
      const createOpts = {
        token: opts.apiToken,
        ...(opts.teamId !== undefined ? { teamId: opts.teamId } : {}),
        ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
        // No source — creates an empty sandbox. Vercel requires vcpus >= 2
        resources: { vcpus: 2 },
        timeout: SDK_CREATION_TIMEOUT_MS,
      };

      // let: mutable sdk — assigned in try block
      let sdk: Awaited<ReturnType<typeof Sandbox.create>>;
      try {
        sdk = await Sandbox.create(createOpts);
      } catch (e: unknown) {
        // Surface API error details for debugging
        const detail = e instanceof Error ? e.message : String(e);
        const apiJson =
          e !== null && typeof e === "object" && "json" in e
            ? ` — ${JSON.stringify((e as Record<string, unknown>).json)}`
            : "";
        throw new Error(`Vercel Sandbox.create failed: ${detail}${apiJson}`, { cause: e });
      }

      return {
        commands: {
          run: async (cmd, execOpts) => {
            // The adapter joins command+args into a flat string (e.g. "echo hello").
            // Vercel SDK expects cmd + args separately, so wrap in sh -c to let
            // the shell parse the full command string (including redirections).
            const cmdResult = await sdk.runCommand("sh", ["-c", cmd], {
              ...(execOpts?.cwd !== undefined ? { cwd: execOpts.cwd } : {}),
              ...(execOpts?.envs !== undefined ? { env: execOpts.envs } : {}),
            });

            // CommandFinished exposes stdout/stderr as async methods
            const stdout = await cmdResult.stdout();
            const stderr = await cmdResult.stderr();

            // Note: Vercel SDK runCommand() collects all output before returning.
            // onStdout/onStderr are invoked post-hoc with full output, not per-chunk.
            execOpts?.onStdout?.(stdout);
            execOpts?.onStderr?.(stderr);

            return {
              exitCode: cmdResult.exitCode,
              stdout,
              stderr,
            };
          },
        },
        files: {
          read: async (path: string): Promise<string> => {
            const buf = await sdk.readFileToBuffer({ path });
            if (buf === null) {
              throw new Error(`File not found: ${path}`);
            }
            return new TextDecoder().decode(buf);
          },
          write: async (path: string, content: string): Promise<void> => {
            await sdk.writeFiles([{ path, content: Buffer.from(content) }]);
          },
        },
        close: async (): Promise<void> => {
          await sdk.stop();
        },
      };
    },
  };

  // Create adapter using the real SDK client
  const adapterResult = createVercelAdapter({
    apiToken,
    ...(teamId !== undefined ? { teamId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    client,
  });
  assert("Vercel adapter created", adapterResult.ok);
  if (!adapterResult.ok) {
    console.log(`  Detail: ${adapterResult.error.message}\n`);
    return;
  }

  const adapter = adapterResult.value;

  console.log("  Creating Vercel sandbox...");
  const instance = await withTimeout(
    () => adapter.create(TEST_PROFILE),
    90_000,
    "Vercel sandbox creation",
  );
  assert("Vercel sandbox instance created", instance !== undefined);

  try {
    await runInstanceTests(instance, "Vercel");
  } finally {
    console.log("  Destroying Vercel sandbox...");
    await withTimeout(() => instance.destroy(), 15_000, "Vercel sandbox destroy");
    assert("Vercel sandbox destroyed", true);
  }
}

// ---------------------------------------------------------------------------
// Stage 3: Docker
// ---------------------------------------------------------------------------

/** Run a Docker CLI command and return stdout. */
async function dockerExec(args: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

/** Create a real DockerClient that wraps the Docker CLI. */
function createDockerCliClient(): DockerClient {
  return {
    createContainer: async (opts: DockerCreateOpts): Promise<DockerContainer> => {
      // Build docker create args
      const createArgs = ["create", "--interactive"];
      if (opts.networkMode !== undefined) createArgs.push(`--network=${opts.networkMode}`);
      if (opts.memory !== undefined) createArgs.push(`--memory=${opts.memory}`);
      if (opts.pidsLimit !== undefined) createArgs.push(`--pids-limit=${opts.pidsLimit}`);
      if (opts.env !== undefined) {
        for (const [k, v] of Object.entries(opts.env)) {
          createArgs.push("-e", `${k}=${v}`);
        }
      }
      if (opts.capAdd !== undefined) {
        for (const cap of opts.capAdd) {
          createArgs.push(`--cap-add=${cap}`);
        }
      }
      createArgs.push(opts.image, "sh");

      const createResult = await dockerExec(createArgs);
      if (createResult.exitCode !== 0) {
        throw new Error(`docker create failed: ${createResult.stderr}`);
      }
      const containerId = createResult.stdout.trim();

      // Start the container
      const startResult = await dockerExec(["start", containerId]);
      if (startResult.exitCode !== 0) {
        throw new Error(`docker start failed: ${startResult.stderr}`);
      }

      return {
        id: containerId,
        exec: async (cmd, execOpts) => {
          const execArgs = ["exec"];
          if (execOpts?.env !== undefined) {
            for (const [k, v] of Object.entries(execOpts.env)) {
              execArgs.push("-e", `${k}=${v}`);
            }
          }
          execArgs.push(containerId, "sh", "-c", cmd);
          return dockerExec(execArgs);
        },
        readFile: async (path) => {
          const result = await dockerExec(["exec", containerId, "cat", path]);
          if (result.exitCode !== 0) {
            throw new Error(`readFile failed: ${result.stderr}`);
          }
          return result.stdout;
        },
        writeFile: async (path, content) => {
          // Use docker exec with sh -c and heredoc-style echo
          const proc = Bun.spawn(
            ["docker", "exec", "-i", containerId, "sh", "-c", `cat > ${path}`],
            { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
          );
          proc.stdin.write(content);
          proc.stdin.end();
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            throw new Error(`writeFile failed: ${stderr}`);
          }
        },
        stop: async () => {
          await dockerExec(["stop", "-t", "3", containerId]);
        },
        remove: async () => {
          await dockerExec(["rm", "-f", containerId]);
        },
      };
    },
  };
}

async function stage3(): Promise<void> {
  console.log("\n[stage 3] Docker container sandbox — full lifecycle\n");

  const enabled = process.env.DOCKER_INTEGRATION;
  if (enabled !== "1") {
    console.log("  \x1b[33mSKIP\x1b[0m  DOCKER_INTEGRATION not set to 1\n");
    return;
  }

  // Verify Docker daemon is reachable
  const versionResult = await dockerExec(["version", "--format", "{{.Server.Version}}"]);
  if (versionResult.exitCode !== 0) {
    console.log("  \x1b[33mSKIP\x1b[0m  Docker daemon not reachable\n");
    return;
  }
  console.log(`  Docker server: ${versionResult.stdout.trim()}`);

  // Pull image if not present
  console.log("  Pulling ubuntu:22.04 (if needed)...");
  await dockerExec(["pull", "-q", "ubuntu:22.04"]);

  const client = createDockerCliClient();

  const adapterResult = createDockerAdapter({ client });
  assert("Docker adapter created", adapterResult.ok);
  if (!adapterResult.ok) {
    console.log(`  Detail: ${adapterResult.error.message}\n`);
    return;
  }

  const adapter = adapterResult.value;

  console.log("  Creating Docker container...");
  const instance = await withTimeout(
    () => adapter.create(TEST_PROFILE),
    60_000,
    "Docker container creation",
  );
  assert("Docker container instance created", instance !== undefined);

  try {
    await runInstanceTests(instance, "Docker");
  } finally {
    console.log("  Destroying Docker container...");
    await withTimeout(() => instance.destroy(), 15_000, "Docker container destroy");
    assert("Docker container destroyed", true);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n=== E2E: Cloud Sandbox Adapters — Full Lifecycle Validation ===");

  // Run each stage in isolation — one failure must not prevent others from running
  for (const stage of [stage1, stage2, stage3]) {
    try {
      await stage();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      assert(`${stage.name} completed without crash`, false, msg);
    }
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const allPassed = passed === total;

  console.log(`\n[e2e] Results: ${passed}/${total} passed`);

  if (!allPassed) {
    console.error("\n[e2e] Failed assertions:");
    for (const r of results) {
      if (!r.passed) {
        console.error(`  FAIL  ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
      }
    }
    process.exit(1);
  }

  console.log("\n=== ALL E2E CHECKS PASSED ===\n");
}

main().catch((error: unknown) => {
  console.error("\nE2E FAILED:", error);
  process.exit(1);
});
