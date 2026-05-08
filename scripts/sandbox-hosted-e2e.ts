#!/usr/bin/env bun
/**
 * End-to-end harness for the hosted sandbox adapters.
 *
 * Runs scenarios from the corner-case table against a real provider OR
 * against a fault-injection wrapper that simulates timeouts / hangs.
 *
 * Usage:
 *   E2B_API_KEY=... bun run scripts/sandbox-hosted-e2e.ts --provider e2b
 *   DAYTONA_API_KEY=... bun run scripts/sandbox-hosted-e2e.ts --provider daytona
 *   bun run scripts/sandbox-hosted-e2e.ts --provider e2b --only abort,binary
 *   bun run scripts/sandbox-hosted-e2e.ts --provider e2b --faults    # synthetic only
 *
 * Selecting `--faults` runs the timeout/hang scenarios against a wrapper
 * that does NOT need provider credentials — useful in CI on every PR.
 * Without `--faults` the harness exits skipped if no API key is set.
 *
 * SDK wrappers: the L2 packages depend only on `@koi/core` and take an
 * injected client. This script imports the real SDKs dynamically so the
 * adapter packages stay dependency-free. Install once at the repo root:
 *   bun add -d @e2b/code-interpreter @daytonaio/sdk
 */

import type {
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "../packages/kernel/core/src/index.js";
import { createDaytonaAdapter } from "../packages/sandbox/sandbox-daytona/src/adapter.js";
import type {
  DaytonaClient,
  DaytonaSdkSandbox,
} from "../packages/sandbox/sandbox-daytona/src/types.js";
import { createE2bAdapter } from "../packages/sandbox/sandbox-e2b/src/adapter.js";
import type { E2bClient, E2bSdkSandbox } from "../packages/sandbox/sandbox-e2b/src/types.js";

type Provider = "e2b" | "daytona";

interface Args {
  readonly provider: Provider;
  readonly only?: ReadonlySet<string>;
  readonly faults: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let provider: Provider | undefined;
  let only: ReadonlySet<string> | undefined;
  let faults = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") {
      const v = argv[++i];
      if (v !== "e2b" && v !== "daytona") throw new Error("--provider must be e2b|daytona");
      provider = v;
    } else if (a === "--only") {
      only = new Set((argv[++i] ?? "").split(",").filter(Boolean));
    } else if (a === "--faults") {
      faults = true;
    }
  }
  if (provider === undefined) throw new Error("--provider required");
  return only !== undefined ? { provider, only, faults } : { provider, faults };
}

const openProfile: SandboxProfile = {
  filesystem: { defaultReadAccess: "open" },
  network: { allow: true },
  resources: {},
};

const closedFsProfile: SandboxProfile = {
  filesystem: { defaultReadAccess: "closed" },
  network: { allow: true },
  resources: {},
};

interface Scenario {
  readonly name: string;
  readonly tag: string;
  /** When true, the scenario must run against the real provider. */
  readonly requiresProvider: boolean;
  readonly run: (mk: () => Promise<SandboxAdapter>) => Promise<void>;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function withInstance(
  mk: () => Promise<SandboxAdapter>,
  fn: (inst: SandboxInstance) => Promise<void>,
): Promise<void> {
  const adapter = await mk();
  const inst = await adapter.create(openProfile);
  try {
    await fn(inst);
  } finally {
    await inst.destroy().catch(() => {});
  }
}

const scenarios: readonly Scenario[] = [
  {
    name: "golden path: echo + exit 0",
    tag: "golden",
    requiresProvider: true,
    run: (mk) =>
      withInstance(mk, async (inst) => {
        const r = await inst.exec("echo", ["hello"]);
        assert(r.exitCode === 0, `exit ${r.exitCode}`);
        assert(r.stdout.includes("hello"), `stdout=${r.stdout}`);
      }),
  },
  {
    name: "non-zero exit code propagates",
    tag: "exit",
    requiresProvider: true,
    run: (mk) =>
      withInstance(mk, async (inst) => {
        const r = await inst.exec("sh", ["-c", "exit 7"]);
        assert(r.exitCode === 7, `expected 7 got ${r.exitCode}`);
      }),
  },
  {
    name: "stdout/stderr split + interleave order",
    tag: "split",
    requiresProvider: true,
    run: (mk) =>
      withInstance(mk, async (inst) => {
        const r = await inst.exec("sh", ["-c", "echo A; echo B >&2; echo C"]);
        assert(r.stdout.includes("A") && r.stdout.includes("C"), `stdout=${r.stdout}`);
        assert(r.stderr.includes("B"), `stderr=${r.stderr}`);
      }),
  },
  {
    name: "binary roundtrip (writeFile/readFile preserves 0x00..0xFF)",
    tag: "binary",
    requiresProvider: true,
    run: (mk) =>
      withInstance(mk, async (inst) => {
        const bytes = new Uint8Array(256);
        for (let i = 0; i < 256; i++) bytes[i] = i;
        await inst.writeFile("/tmp/koi-e2e-bin", bytes);
        const back = await inst.readFile("/tmp/koi-e2e-bin");
        assert(back.length === 256, `len ${back.length}`);
        for (let i = 0; i < 256; i++) assert(back[i] === i, `byte ${i} mismatch`);
      }),
  },
  {
    name: "abort mid-exec maps to exit 130 within reasonable wallclock",
    tag: "abort",
    requiresProvider: true,
    run: (mk) =>
      withInstance(mk, async (inst) => {
        const ctrl = new AbortController();
        const start = Date.now();
        setTimeout(() => ctrl.abort(), 500);
        const r = await inst.exec("sleep", ["60"], { signal: ctrl.signal });
        const elapsed = Date.now() - start;
        assert(r.exitCode === 130, `expected 130 got ${r.exitCode}`);
        assert(elapsed < 10_000, `abort took ${elapsed}ms (post-abort confirm cap is 5s)`);
      }),
  },
  {
    name: "output cap honoured (truncated=true, no host OOM)",
    tag: "cap",
    requiresProvider: true,
    run: (mk) =>
      withInstance(mk, async (inst) => {
        const r = await inst.exec("sh", ["-c", "yes | head -c 5000000"], {
          maxOutputBytes: 1_000_000,
        });
        assert(r.stdout.length <= 1_000_000, `stdout ${r.stdout.length} > cap`);
        assert(r.truncated === true, `expected truncated=true`);
      }),
  },
  {
    name: "streaming callbacks fire incrementally",
    tag: "stream",
    requiresProvider: true,
    run: (mk) =>
      withInstance(mk, async (inst) => {
        const chunks: string[] = [];
        await inst.exec("sh", ["-c", "for i in 1 2 3; do echo chunk-$i; sleep 1; done"], {
          onStdout: (s) => chunks.push(s),
        });
        assert(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
      }),
  },
  {
    name: "concurrent destroy() coalesces",
    tag: "destroy-coalesce",
    requiresProvider: true,
    run: async (mk) => {
      const adapter = await mk();
      const inst = await adapter.create(openProfile);
      const all = await Promise.allSettled([inst.destroy(), inst.destroy(), inst.destroy()]);
      for (const r of all) assert(r.status === "fulfilled", `concurrent destroy failed`);
    },
  },
  {
    name: "quarantine: ops blocked after SDK rejection",
    tag: "quarantine",
    requiresProvider: true,
    run: async (mk) => {
      const adapter = await mk();
      const inst = await adapter.create(openProfile);
      try {
        await inst.exec("nonexistent-binary-xyz", []).catch(() => {});
        // After indeterminate failure, exec must reject quarantined.
        const second = await inst.exec("echo", ["hi"]).catch((e) => e as Error);
        assert(
          second instanceof Error && /quarantined|INDETERMINATE/.test(second.message),
          `expected quarantine, got ${second}`,
        );
      } finally {
        await inst.destroy().catch(() => {});
      }
    },
  },
  {
    name: "profile fail-closed: closed filesystem rejected before provider call",
    tag: "profile",
    requiresProvider: false,
    run: async (mk) => {
      const adapter = await mk();
      const err = await adapter.create(closedFsProfile).catch((e) => e as Error);
      assert(err instanceof Error, `expected reject, got ${err}`);
    },
  },
];

const faultScenarios: readonly Scenario[] = [
  {
    name: "create() hangs → INDETERMINATE within ~30s",
    tag: "create-timeout",
    requiresProvider: false,
    run: async () => {
      const start = Date.now();
      const adapter = makeFaultE2bAdapter({ createDelayMs: 60_000 });
      const err = await adapter.create(openProfile).catch((e) => e as Error);
      const elapsed = Date.now() - start;
      assert(err instanceof Error && /INDETERMINATE/.test(err.message), `got ${err}`);
      assert(elapsed >= 28_000 && elapsed < 35_000, `create timeout took ${elapsed}ms`);
    },
  },
  {
    name: "create() timeout + late kill hangs → LATE_CLEANUP_TIMEOUT warning",
    tag: "create-leak",
    requiresProvider: false,
    run: async () => {
      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (m: string) => warns.push(String(m));
      try {
        // Create stalls past local timeout; the eventually-returned handle
        // has a kill() that never settles → reconciler must emit
        // LATE_CLEANUP_TIMEOUT within its 10s bound.
        const adapter = makeFaultE2bAdapter({
          createDelayMs: 31_000,
          killHangs: true,
          ignoreCreateAbort: true,
        });
        const err = await adapter.create(openProfile).catch((e) => e as Error);
        assert(err instanceof Error && /INDETERMINATE/.test(err.message), `got ${err}`);
        // Wait past 31s create + 10s late-kill bound = ~12s remaining
        // after the create error surfaces (we already burned ~30s).
        await new Promise((r) => setTimeout(r, 12_000));
        assert(
          warns.some((w) => /LATE_CLEANUP_TIMEOUT/.test(w)),
          `expected LATE_CLEANUP_TIMEOUT, got: ${warns.join(" | ")}`,
        );
      } finally {
        console.warn = origWarn;
      }
    },
  },
  {
    name: "destroy() hangs → bounded teardown + retryable",
    tag: "destroy-timeout",
    requiresProvider: false,
    run: async () => {
      const adapter = makeFaultE2bAdapter({ killHangs: true });
      const inst = await adapter.create(openProfile);
      const start = Date.now();
      const err = await inst.destroy().catch((e) => e as Error);
      const elapsed = Date.now() - start;
      assert(err instanceof Error && /destroy\(\) timed out/.test(err.message), `got ${err}`);
      assert(elapsed < 12_000, `destroy bound exceeded: ${elapsed}ms`);
    },
  },
];

// ---------- adapter factories ----------

interface FaultOpts {
  readonly createDelayMs?: number;
  readonly killHangs?: boolean;
  /** When true, the fake ignores the cancellation signal — simulating a
   *  degraded provider that doesn't honour AbortSignal. Use to exercise
   *  the late-cleanup reconciler path. */
  readonly ignoreCreateAbort?: boolean;
}

function makeFakeE2bSandbox(): E2bSdkSandbox {
  return {
    commands: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      supportsMaxOutputBytes: true,
      supportsAbort: true,
      supportsStdin: true,
    },
    files: {
      read: async () => "",
      write: async () => {},
      readBytes: async () => new Uint8Array(),
      writeBytes: async () => {},
    },
    kill: async () => {},
  };
}

function makeFaultE2bAdapter(faults: FaultOpts): SandboxAdapter {
  const client: E2bClient = {
    supportsTeardown: true,
    supportsCancelCreate: true,
    createSandbox: async (opts) => {
      if (faults.createDelayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, faults.createDelayMs);
          if (faults.ignoreCreateAbort !== true) {
            opts.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            });
          }
        });
      }
      const base = makeFakeE2bSandbox();
      if (faults.killHangs === true) {
        return { ...base, kill: () => new Promise<void>(() => {}) };
      }
      return base;
    },
  };
  const r = createE2bAdapter({ apiKey: "fake", client });
  if (!r.ok) throw new Error(`adapter init failed: ${r.error.message}`);
  return r.value;
}

async function makeRealE2bAdapter(): Promise<SandboxAdapter> {
  const apiKey = process.env.E2B_API_KEY;
  if (apiKey === undefined || apiKey === "") throw new Error("E2B_API_KEY not set");
  // @ts-expect-error optional dev-dep — see file header for install command.
  const sdk = await import("@e2b/code-interpreter").catch(() => {
    throw new Error("Install: bun add -d @e2b/code-interpreter");
  });
  const client: E2bClient = {
    supportsTeardown: true,
    supportsCancelCreate: false,
    createSandbox: async (opts) => {
      const sb = await (sdk as unknown as E2bSdkModule).Sandbox.create({
        apiKey,
        metadata: { label: opts.label },
      });
      return wrapE2bSandbox(sb);
    },
  };
  const r = createE2bAdapter({ apiKey, client });
  if (!r.ok) throw new Error(`adapter init failed: ${r.error.message}`);
  return r.value;
}

interface E2bRawCommandResult {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface E2bRawCommandOpts {
  readonly cwd?: string | undefined;
  readonly envs?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly onStdout?: ((d: string) => void) | undefined;
  readonly onStderr?: ((d: string) => void) | undefined;
}

interface E2bRawSandbox {
  readonly commands: {
    readonly run: (cmd: string, opts: E2bRawCommandOpts) => Promise<E2bRawCommandResult>;
  };
  readonly files: {
    readonly read: (p: string) => Promise<string>;
    readonly write: (p: string, c: string) => Promise<void>;
    readonly readBytes?: (p: string) => Promise<Uint8Array>;
    readonly writeBytes?: (p: string, c: Uint8Array) => Promise<void>;
  };
  readonly kill: () => Promise<void>;
}

interface E2bSdkModule {
  readonly Sandbox: {
    readonly create: (opts: {
      readonly apiKey: string;
      readonly metadata: { readonly label: string };
    }) => Promise<E2bRawSandbox>;
  };
}

function wrapE2bSandbox(sb: E2bRawSandbox): E2bSdkSandbox {
  return {
    commands: {
      run: async (cmd, opts) => {
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        const res = await sb.commands.run(cmd, {
          cwd: opts?.cwd,
          envs: opts?.envs,
          timeoutMs: opts?.timeoutMs,
          onStdout: (d: string) => {
            stdoutChunks.push(d);
            opts?.onStdout?.(d);
          },
          onStderr: (d: string) => {
            stderrChunks.push(d);
            opts?.onStderr?.(d);
          },
        });
        return {
          exitCode: res.exitCode ?? 0,
          stdout: stdoutChunks.join("") || (res.stdout ?? ""),
          stderr: stderrChunks.join("") || (res.stderr ?? ""),
        };
      },
      supportsMaxOutputBytes: false,
      supportsAbort: false,
      supportsStdin: false,
    },
    files: {
      read: (p) => sb.files.read(p),
      write: (p, c) => sb.files.write(p, c),
      ...(sb.files.readBytes !== undefined ? { readBytes: sb.files.readBytes } : {}),
      ...(sb.files.writeBytes !== undefined ? { writeBytes: sb.files.writeBytes } : {}),
    },
    kill: () => sb.kill(),
  };
}

async function makeRealDaytonaAdapter(): Promise<SandboxAdapter> {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (apiKey === undefined || apiKey === "") throw new Error("DAYTONA_API_KEY not set");
  // @ts-expect-error optional dev-dep — see file header for install command.
  const sdk = await import("@daytonaio/sdk").catch(() => {
    throw new Error("Install: bun add -d @daytonaio/sdk");
  });
  const client: DaytonaClient = {
    supportsWorkspaceDelete: true,
    supportsCancelCreate: false,
    createSandbox: async (opts) => {
      const SdkModule = sdk as unknown as DaytonaSdkModule;
      const dt = new SdkModule.Daytona({ apiKey });
      const ws = await dt.create({ labels: { "koi-label": opts.label } });
      return wrapDaytonaSandbox(ws);
    },
  };
  const r = createDaytonaAdapter({ apiKey, client });
  if (!r.ok) throw new Error(`adapter init failed: ${r.error.message}`);
  return r.value;
}

interface DaytonaRawCommandResult {
  readonly exitCode?: number;
  readonly result?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface DaytonaRawWorkspace {
  readonly process: {
    readonly executeCommand: (
      cmd: string,
      cwd: string | undefined,
      envs: Readonly<Record<string, string>> | undefined,
      timeoutMs: number | undefined,
    ) => Promise<DaytonaRawCommandResult>;
  };
  readonly fs: {
    readonly downloadFile: (p: string) => Promise<Uint8Array>;
    readonly uploadFile: (c: Uint8Array, p: string) => Promise<void>;
  };
  readonly close?: () => Promise<void>;
  readonly delete: () => Promise<void>;
}

interface DaytonaSdkModule {
  readonly Daytona: new (opts: {
    readonly apiKey: string;
  }) => {
    readonly create: (opts: {
      readonly labels: Readonly<Record<string, string>>;
    }) => Promise<DaytonaRawWorkspace>;
  };
}

function wrapDaytonaSandbox(ws: DaytonaRawWorkspace): DaytonaSdkSandbox {
  return {
    commands: {
      run: async (cmd, opts) => {
        const res = await ws.process.executeCommand(cmd, opts?.cwd, opts?.envs, opts?.timeoutMs);
        return {
          exitCode: res.exitCode ?? 0,
          stdout: res.result ?? res.stdout ?? "",
          stderr: res.stderr ?? "",
        };
      },
      supportsMaxOutputBytes: false,
      supportsAbort: false,
      supportsStdin: false,
    },
    files: {
      read: (p) => ws.fs.downloadFile(p).then((b: Uint8Array) => new TextDecoder().decode(b)),
      write: async (p, c) => {
        await ws.fs.uploadFile(new TextEncoder().encode(c), p);
      },
      readBytes: (p) => ws.fs.downloadFile(p),
      writeBytes: (p, c) => ws.fs.uploadFile(c, p),
    },
    close: () => ws.close?.() ?? Promise.resolve(),
    delete: () => ws.delete(),
  };
}

// ---------- runner ----------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const all: readonly Scenario[] = [...scenarios, ...faultScenarios];
  const selected =
    args.only !== undefined
      ? all.filter((s) => args.only?.has(s.tag) === true)
      : args.faults
        ? all.filter((s) => !s.requiresProvider)
        : all;

  const mk =
    args.provider === "e2b"
      ? args.faults
        ? () => Promise.resolve(makeFaultE2bAdapter({}))
        : makeRealE2bAdapter
      : args.faults
        ? () => Promise.resolve(makeFaultE2bAdapter({})) // daytona faults reuse e2b shape
        : makeRealDaytonaAdapter;

  let pass = 0;
  let fail = 0;
  let skip = 0;
  for (const s of selected) {
    if (s.requiresProvider && args.faults) {
      console.log(`skip  ${s.tag.padEnd(20)} ${s.name}`);
      skip++;
      continue;
    }
    const start = Date.now();
    try {
      await s.run(mk);
      const ms = Date.now() - start;
      console.log(`ok    ${s.tag.padEnd(20)} ${s.name} (${ms}ms)`);
      pass++;
    } catch (e: unknown) {
      const ms = Date.now() - start;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`FAIL  ${s.tag.padEnd(20)} ${s.name} (${ms}ms)\n      ${msg}`);
      fail++;
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped (provider=${args.provider})`);
  if (fail > 0) process.exit(1);
}

await main();
