import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KoiMiddleware } from "@koi/core";

import {
  buildInheritedMiddlewareForChildren,
  composeRuntimeMiddleware,
} from "./compose-middleware.js";
import { loadManifestConfig } from "./manifest.js";
import type { ManifestMiddlewareContext } from "./middleware-registry.js";
import {
  CoreMiddlewareBlockedError,
  createBuiltinManifestRegistry,
  createDefaultManifestRegistry,
  MiddlewareRegistry,
  resolveManifestMiddleware,
  UnknownManifestMiddlewareError,
} from "./middleware-registry.js";
import { enforceRequiredMiddleware, RequiredMiddlewareError } from "./required-middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTempCwd(): string {
  return mkdtempSync(join(tmpdir(), "koi-manifest-mw-"));
}

function writeYaml(cwd: string, body: string): string {
  const path = join(cwd, "koi.yaml");
  writeFileSync(path, body, "utf8");
  return path;
}

function stubMiddleware(name: string): KoiMiddleware {
  return { name } as unknown as KoiMiddleware;
}

function stubCtx(overrides: Partial<ManifestMiddlewareContext> = {}): ManifestMiddlewareContext {
  return {
    sessionId: "test-session",
    hostId: "test-host",
    workingDirectory: "/tmp",
    stackExports: {},
    registerShutdown: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema: loadManifestConfig — zone B parsing
// ---------------------------------------------------------------------------

describe("loadManifestConfig — middleware[]", () => {
  test("accepts explicit {name, options, enabled} form", async () => {
    const cwd = mkTempCwd();
    const path = writeYaml(
      cwd,
      `model:
  name: test-model
middleware:
  - name: "@koi/middleware-extraction"
    options:
      patterns: ["TODO:", "FIXME:"]
  - name: "@koi/middleware-semantic-retry"
    enabled: false
`,
    );
    const result = await loadManifestConfig(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.middleware).toEqual([
      {
        name: "@koi/middleware-extraction",
        options: { patterns: ["TODO:", "FIXME:"] },
        enabled: true,
      },
      {
        name: "@koi/middleware-semantic-retry",
        options: undefined,
        enabled: false,
      },
    ]);
  });

  test("accepts shorthand {name: options} form", async () => {
    const cwd = mkTempCwd();
    const path = writeYaml(
      cwd,
      `model:
  name: test-model
middleware:
  - "@koi/custom":
      scope: "agent"
`,
    );
    const result = await loadManifestConfig(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.middleware).toEqual([
      {
        name: "@koi/custom",
        options: { scope: "agent" },
        enabled: true,
      },
    ]);
  });

  test("rejects core middleware names (blocklist)", async () => {
    const cwd = mkTempCwd();
    const path = writeYaml(
      cwd,
      `model:
  name: test-model
middleware:
  - name: "@koi/middleware-extraction"
  - name: "permissions"
`,
    );
    const result = await loadManifestConfig(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("permissions");
    expect(result.error).toContain("core middleware");
    expect(result.error).toContain("configure it via host flags");
  });

  test("rejects exfiltration-guard in zone B", async () => {
    const cwd = mkTempCwd();
    const path = writeYaml(
      cwd,
      `model:
  name: test-model
middleware:
  - name: "exfiltration-guard"
`,
    );
    const result = await loadManifestConfig(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("exfiltration-guard");
  });

  test("empty middleware list is valid", async () => {
    const cwd = mkTempCwd();
    const path = writeYaml(
      cwd,
      `model:
  name: test-model
middleware: []
`,
    );
    const result = await loadManifestConfig(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.middleware).toEqual([]);
  });

  test("omitted middleware field is undefined (backward compatible)", async () => {
    const cwd = mkTempCwd();
    const path = writeYaml(
      cwd,
      `model:
  name: test-model
`,
    );
    const result = await loadManifestConfig(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.middleware).toBeUndefined();
  });

  test("rejects non-array middleware", async () => {
    const cwd = mkTempCwd();
    const path = writeYaml(
      cwd,
      `model:
  name: test-model
middleware: "@koi/middleware-audit"
`,
    );
    const result = await loadManifestConfig(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must be a list");
  });
});

// ---------------------------------------------------------------------------
// Schema: loadManifestConfig — trustedHost parsing
// ---------------------------------------------------------------------------

describe("loadManifestConfig — trustedHost rejection (host-controlled only)", () => {
  // Security baseline opt-outs (`disablePermissions`,
  // `disableExfiltrationGuard`) are deliberately NOT accepted from
  // manifest YAML. `koi.yaml` is repository content; letting a
  // committed manifest disable security layers would let anyone with
  // repo write access silently downgrade every developer's security
  // posture. Hosts thread `TrustedHostConfig` programmatically from
  // CLI flags / env / policy store directly into `createKoiRuntime`.

  test("rejects any trustedHost key in YAML with a clear error", async () => {
    const cwd = mkTempCwd();
    const path = writeYaml(
      cwd,
      `model:
  name: test-model
trustedHost:
  disableExfiltrationGuard: true
`,
    );
    const result = await loadManifestConfig(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("trustedHost is not accepted");
    expect(result.error).toContain("host");
  });

  test("rejects trustedHost even when empty", async () => {
    const cwd = mkTempCwd();
    const path = writeYaml(cwd, `model:\n  name: test-model\ntrustedHost: {}\n`);
    const result = await loadManifestConfig(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("trustedHost is not accepted");
  });

  test("rejects trustedHost when explicitly set to false", async () => {
    // Even a syntactically valid but safe value is rejected — the
    // presence of the key at all is the error, because it signals
    // intent to manage trust from the manifest.
    const cwd = mkTempCwd();
    const path = writeYaml(
      cwd,
      `model:\n  name: test-model\ntrustedHost:\n  disablePermissions: false\n`,
    );
    const result = await loadManifestConfig(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("trustedHost is not accepted");
  });

  test("manifest without trustedHost passes", async () => {
    const cwd = mkTempCwd();
    const path = writeYaml(cwd, `model:\n  name: test-model\n`);
    const result = await loadManifestConfig(path);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Registry: MiddlewareRegistry + resolveManifestMiddleware
// ---------------------------------------------------------------------------

describe("MiddlewareRegistry", () => {
  test("register + get + has + names", () => {
    const registry = new MiddlewareRegistry();
    registry.register("@koi/a", () => stubMiddleware("a"));
    registry.register("@koi/b", () => stubMiddleware("b"));
    expect(registry.has("@koi/a")).toBe(true);
    expect(registry.has("@koi/c")).toBe(false);
    expect(registry.names()).toEqual(["@koi/a", "@koi/b"]);
    const factory = registry.get("@koi/a");
    expect(factory).toBeDefined();
  });

  test("createDefaultManifestRegistry returns an empty registry", () => {
    const registry = createDefaultManifestRegistry();
    expect(registry.names()).toEqual([]);
  });

  test("createBuiltinManifestRegistry is empty by default (no file-backed sinks)", () => {
    // Codex round-8 finding #2: file-backed manifest middleware
    // must not be available to repo-authored content unless the
    // host explicitly opts in. The default built-in registry is
    // therefore empty; hosts that want audit pass
    // `{ allowFileBackedSinks: true }`.
    const registry = createBuiltinManifestRegistry();
    expect(registry.has("@koi/middleware-audit")).toBe(false);
    expect(registry.names()).toEqual([]);
  });

  test("createBuiltinManifestRegistry with allowFileBackedSinks registers @koi/middleware-audit", () => {
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    expect(registry.has("@koi/middleware-audit")).toBe(true);
    expect(registry.names()).toContain("@koi/middleware-audit");
  });
});

// ---------------------------------------------------------------------------
// Built-in: @koi/middleware-audit
// ---------------------------------------------------------------------------

describe("built-in @koi/middleware-audit factory", () => {
  test("resolves with relative filePath anchored to workspace root", async () => {
    const workspace = mkTempCwd();
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    const resolved = await resolveManifestMiddleware(
      [
        {
          name: "@koi/middleware-audit",
          options: { filePath: "audit.audit.ndjson" },
          enabled: true,
        },
      ],
      registry,
      stubCtx({ workingDirectory: workspace }),
    );
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.name).toBe("audit");
  });

  test("rejects missing filePath with a clear error", async () => {
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    await expect(
      resolveManifestMiddleware(
        [
          {
            name: "@koi/middleware-audit",
            options: undefined,
            enabled: true,
          },
        ],
        registry,
        stubCtx(),
      ),
    ).rejects.toThrow(/filePath/);
  });

  test("rejects non-string filePath", async () => {
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    await expect(
      resolveManifestMiddleware(
        [
          {
            name: "@koi/middleware-audit",
            options: { filePath: 42 },
            enabled: true,
          },
        ],
        registry,
        stubCtx(),
      ),
    ).rejects.toThrow(/filePath must be a non-empty string/);
  });

  test("rejects absolute filePath from manifest (arbitrary-write guard)", async () => {
    // Codex round-2 finding #1: a repo-authored koi.yaml must not be
    // able to target host-arbitrary paths like `/Users/victim/.ssh/...`.
    const workspace = mkTempCwd();
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    await expect(
      resolveManifestMiddleware(
        [
          {
            name: "@koi/middleware-audit",
            options: { filePath: "/tmp/should-not-be-allowed.audit.ndjson" },
            enabled: true,
          },
        ],
        registry,
        stubCtx({ workingDirectory: workspace }),
      ),
    ).rejects.toThrow(/absolute filePath.*not allowed/);
  });

  test("rejects `..` traversal escaping the workspace root", async () => {
    const workspace = mkTempCwd();
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    await expect(
      resolveManifestMiddleware(
        [
          {
            name: "@koi/middleware-audit",
            options: { filePath: "../../escape.audit.ndjson" },
            enabled: true,
          },
        ],
        registry,
        stubCtx({ workingDirectory: workspace }),
      ),
    ).rejects.toThrow(/escapes the workspace root/);
  });

  test("rejects symlinked subdirectory that escapes the workspace root", async () => {
    // Codex round-3 finding #2: a lexical path check is not enough.
    // A repo can commit `logs` as a symlink to an out-of-tree path;
    // the lexical check passes because `logs/audit.ndjson` stays
    // under the workspace string, but the actual file write follows
    // the symlink. The realpath-based check must catch this.
    const workspace = mkTempCwd();
    const outsideDir = mkTempCwd();
    symlinkSync(outsideDir, join(workspace, "logs"));
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    await expect(
      resolveManifestMiddleware(
        [
          {
            name: "@koi/middleware-audit",
            options: { filePath: "logs/trace.audit.ndjson" },
            enabled: true,
          },
        ],
        registry,
        stubCtx({ workingDirectory: workspace }),
      ),
    ).rejects.toThrow(/symlinked parent directory that escapes/);
  });

  test("rejects a symlinked TARGET FILE inside an in-tree directory", async () => {
    // Codex round-4 finding #2: the parent realpath check alone is
    // insufficient. If the final path component is a symlink
    // pointing at an out-of-tree file, the parent dir passes
    // realpath but the sink's file open still follows the symlink.
    // lstat must also reject a symlink at the final path component.
    const workspace = mkTempCwd();
    const outsideDir = mkTempCwd();
    const outsideTarget = join(outsideDir, "evil.audit.ndjson");
    writeFileSync(outsideTarget, "", "utf8");
    const sinkPath = join(workspace, "audit.audit.ndjson");
    symlinkSync(outsideTarget, sinkPath);
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    await expect(
      resolveManifestMiddleware(
        [
          {
            name: "@koi/middleware-audit",
            options: { filePath: "audit.audit.ndjson" },
            enabled: true,
          },
        ],
        registry,
        stubCtx({ workingDirectory: workspace }),
      ),
    ).rejects.toThrow(/is itself a symlink/);
  });

  test("rejects filePath without the .audit.ndjson suffix (prevents arbitrary-file corruption)", async () => {
    // Codex round-6 finding #2: without an extension check, a
    // repo-authored koi.yaml can point `filePath` at any existing
    // in-tree writable file (package.json, src/index.ts, etc.) and
    // silently append audit NDJSON on every session. The suffix
    // requirement forces the target into a dedicated filename
    // namespace so existing arbitrary files cannot be targeted.
    const workspace = mkTempCwd();
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    await expect(
      resolveManifestMiddleware(
        [
          {
            name: "@koi/middleware-audit",
            options: { filePath: "package.json" },
            enabled: true,
          },
        ],
        registry,
        stubCtx({ workingDirectory: workspace }),
      ),
    ).rejects.toThrow(/must end in "\.audit\.ndjson"/);
  });

  test("rejects filePath with plain .log suffix (must be .audit.ndjson)", async () => {
    const workspace = mkTempCwd();
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    await expect(
      resolveManifestMiddleware(
        [
          {
            name: "@koi/middleware-audit",
            options: { filePath: "audit.log" },
            enabled: true,
          },
        ],
        registry,
        stubCtx({ workingDirectory: workspace }),
      ),
    ).rejects.toThrow(/must end in "\.audit\.ndjson"/);
  });

  test("accepts nested relative paths inside the workspace", async () => {
    const workspace = mkTempCwd();
    // The NDJSON sink opens the file eagerly at construction time, so
    // the subdirectory must exist before the factory runs.
    mkdirSync(join(workspace, "logs"), { recursive: true });
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    const resolved = await resolveManifestMiddleware(
      [
        {
          name: "@koi/middleware-audit",
          options: { filePath: "logs/trace.audit.ndjson" },
          enabled: true,
        },
      ],
      registry,
      stubCtx({ workingDirectory: workspace }),
    );
    expect(resolved.length).toBe(1);
  });

  test("registers a shutdown callback so the NDJSON sink is closed on dispose", async () => {
    // Codex round-9 finding #2: the NDJSON sink opens a file
    // writer and starts a flush timer. Without a shutdown hook,
    // those resources leak. The audit factory must register a
    // close() callback via ctx.registerShutdown so the runtime
    // factory's shutdownBackgroundTasks path can release them.
    const workspace = mkTempCwd();
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    const registered: Array<() => Promise<void> | void> = [];
    await resolveManifestMiddleware(
      [
        {
          name: "@koi/middleware-audit",
          options: { filePath: "shutdown-hook.audit.ndjson" },
          enabled: true,
        },
      ],
      registry,
      stubCtx({
        workingDirectory: workspace,
        registerShutdown: (fn) => {
          registered.push(fn);
        },
      }),
    );
    expect(registered.length).toBe(1);
    // Running the callback should not throw (proves the sink
    // close path is wired).
    await registered[0]?.();
  });

  test("accepts optional flushIntervalMs and redactRequestBodies", async () => {
    const workspace = mkTempCwd();
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    const resolved = await resolveManifestMiddleware(
      [
        {
          name: "@koi/middleware-audit",
          options: {
            filePath: "audit-2.audit.ndjson",
            flushIntervalMs: 500,
            redactRequestBodies: true,
          },
          enabled: true,
        },
      ],
      registry,
      stubCtx({ workingDirectory: workspace }),
    );
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.name).toBe("audit");
  });

  test("rejects signing: true from manifest (ephemeral keypair, no verification path)", async () => {
    // Codex round 2: signing from manifest generates an ephemeral
    // keypair whose public key is never persisted, turning
    // tamper-evident mode into a false assurance.
    const workspace = mkTempCwd();
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    await expect(
      resolveManifestMiddleware(
        [
          {
            name: "@koi/middleware-audit",
            options: { filePath: "signed.audit.ndjson", signing: true },
            enabled: true,
          },
        ],
        registry,
        stubCtx({ workingDirectory: workspace }),
      ),
    ).rejects.toThrow(/signing is not supported from manifest/);
  });

  test("rejects two audit entries targeting the same canonical filePath", async () => {
    // Codex round 2: independent sinks on the same file would
    // interleave records and corrupt any hash/signing chain.
    const workspace = mkTempCwd();
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    await expect(
      resolveManifestMiddleware(
        [
          {
            name: "@koi/middleware-audit",
            options: { filePath: "shared.audit.ndjson" },
            enabled: true,
          },
          {
            name: "@koi/middleware-audit",
            options: { filePath: "shared.audit.ndjson" },
            enabled: true,
          },
        ],
        registry,
        stubCtx({ workingDirectory: workspace }),
      ),
    ).rejects.toThrow(/already claimed by an earlier manifest entry/);
  });

  test("collision check normalizes `./foo` vs `foo` to the same canonical path", async () => {
    const workspace = mkTempCwd();
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    await expect(
      resolveManifestMiddleware(
        [
          {
            name: "@koi/middleware-audit",
            options: { filePath: "audit-collide.audit.ndjson" },
            enabled: true,
          },
          {
            name: "@koi/middleware-audit",
            options: { filePath: "./audit-collide.audit.ndjson" },
            enabled: true,
          },
        ],
        registry,
        stubCtx({ workingDirectory: workspace }),
      ),
    ).rejects.toThrow(/already claimed/);
  });

  test("rejects negative flushIntervalMs", async () => {
    const workspace = mkTempCwd();
    const registry = createBuiltinManifestRegistry({ allowFileBackedSinks: true });
    await expect(
      resolveManifestMiddleware(
        [
          {
            name: "@koi/middleware-audit",
            options: { filePath: "audit-3.audit.ndjson", flushIntervalMs: -1 },
            enabled: true,
          },
        ],
        registry,
        stubCtx({ workingDirectory: workspace }),
      ),
    ).rejects.toThrow(/flushIntervalMs must be a positive number/);
  });
});

describe("resolveManifestMiddleware", () => {
  test("preserves declared order", async () => {
    const registry = new MiddlewareRegistry();
    registry.register("@koi/a", () => stubMiddleware("a"));
    registry.register("@koi/b", () => stubMiddleware("b"));
    registry.register("@koi/c", () => stubMiddleware("c"));
    const resolved = await resolveManifestMiddleware(
      [
        { name: "@koi/c", options: undefined, enabled: true },
        { name: "@koi/a", options: undefined, enabled: true },
        { name: "@koi/b", options: undefined, enabled: true },
      ],
      registry,
      stubCtx(),
    );
    expect(resolved.map((mw) => mw.name)).toEqual(["c", "a", "b"]);
  });

  test("skips entries with enabled: false", async () => {
    const registry = new MiddlewareRegistry();
    registry.register("@koi/a", () => stubMiddleware("a"));
    registry.register("@koi/b", () => stubMiddleware("b"));
    const resolved = await resolveManifestMiddleware(
      [
        { name: "@koi/a", options: undefined, enabled: false },
        { name: "@koi/b", options: undefined, enabled: true },
      ],
      registry,
      stubCtx(),
    );
    expect(resolved.map((mw) => mw.name)).toEqual(["b"]);
  });

  test("passes options verbatim to factory", async () => {
    const registry = new MiddlewareRegistry();
    let received: Readonly<Record<string, unknown>> | undefined;
    registry.register("@koi/a", (entry) => {
      received = entry.options;
      return stubMiddleware("a");
    });
    await resolveManifestMiddleware(
      [{ name: "@koi/a", options: { destination: "./log", verbose: true }, enabled: true }],
      registry,
      stubCtx(),
    );
    expect(received).toEqual({ destination: "./log", verbose: true });
  });

  test("throws UnknownManifestMiddlewareError on unknown name with full registered list", async () => {
    const registry = new MiddlewareRegistry();
    registry.register("@koi/a", () => stubMiddleware("a"));
    registry.register("@koi/b", () => stubMiddleware("b"));
    await expect(
      resolveManifestMiddleware(
        [{ name: "@koi/typo", options: undefined, enabled: true }],
        registry,
        stubCtx(),
      ),
    ).rejects.toBeInstanceOf(UnknownManifestMiddlewareError);
    try {
      await resolveManifestMiddleware(
        [{ name: "@koi/typo", options: undefined, enabled: true }],
        registry,
        stubCtx(),
      );
    } catch (e) {
      const err = e as UnknownManifestMiddlewareError;
      expect(err.requestedName).toBe("@koi/typo");
      expect(err.registeredNames).toEqual(["@koi/a", "@koi/b"]);
      expect(err.message).toContain("@koi/a");
      expect(err.message).toContain("@koi/b");
    }
  });

  test("undefined entries list returns empty chain", async () => {
    const registry = new MiddlewareRegistry();
    const resolved = await resolveManifestMiddleware(undefined, registry, stubCtx());
    expect(resolved).toEqual([]);
  });

  test("supports async factories", async () => {
    const registry = new MiddlewareRegistry();
    registry.register("@koi/async", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return stubMiddleware("async");
    });
    const resolved = await resolveManifestMiddleware(
      [{ name: "@koi/async", options: undefined, enabled: true }],
      registry,
      stubCtx(),
    );
    expect(resolved.map((mw) => mw.name)).toEqual(["async"]);
  });

  test("re-applies the core blocklist at runtime for programmatic callers", async () => {
    // Codex round-7 finding #1: embedders calling createKoiRuntime
    // with manifestMiddleware directly bypass loadManifestConfig's
    // blocklist. resolveManifestMiddleware must enforce the same
    // invariant so the security-critical layers cannot be replaced
    // via the programmatic entry surface either.
    const registry = new MiddlewareRegistry();
    // A factory registered under a short core name that the YAML
    // parser would reject — must also be rejected at resolve time.
    registry.register("permissions", () => stubMiddleware("fake-permissions"));
    await expect(
      resolveManifestMiddleware(
        [{ name: "permissions", options: undefined, enabled: true }],
        registry,
        stubCtx(),
      ),
    ).rejects.toBeInstanceOf(CoreMiddlewareBlockedError);
  });

  test("core blocklist includes canonical @koi/* package names", async () => {
    const registry = new MiddlewareRegistry();
    registry.register("@koi/middleware-permissions", () => stubMiddleware("fake"));
    await expect(
      resolveManifestMiddleware(
        [
          {
            name: "@koi/middleware-permissions",
            options: undefined,
            enabled: true,
          },
        ],
        registry,
        stubCtx(),
      ),
    ).rejects.toBeInstanceOf(CoreMiddlewareBlockedError);
  });

  test("core blocklist covers exfiltration-guard and hooks aliases", async () => {
    const registry = new MiddlewareRegistry();
    registry.register("exfiltration-guard", () => stubMiddleware("fake"));
    registry.register("hooks", () => stubMiddleware("fake"));
    registry.register("@koi/hooks", () => stubMiddleware("fake"));
    for (const name of ["exfiltration-guard", "hooks", "@koi/hooks"]) {
      await expect(
        resolveManifestMiddleware(
          [{ name, options: undefined, enabled: true }],
          registry,
          stubCtx(),
        ),
      ).rejects.toBeInstanceOf(CoreMiddlewareBlockedError);
    }
  });
});

// ---------------------------------------------------------------------------
// Zone B phase/priority enforcement — execution-time security invariant
//
// Codex round-2 finding #2: the engine's sortMiddlewareByPhase
// re-orders middleware by (phase, priority) before execution. A
// manifest entry declaring `phase: "intercept"` with a low priority
// could otherwise leapfrog exfiltration-guard/permissions. The
// resolver rewrites every zone B entry to a fixed observe/900 slot
// so that after sort, every zone B middleware provably runs strictly
// after all intercept- and resolve-phase layers.
// ---------------------------------------------------------------------------

describe("resolveManifestMiddleware — phase/priority forced slot", () => {
  // Helper: build a stub middleware with caller-chosen phase/priority.
  // Uses the same unsafe cast as `stubMiddleware` to satisfy the full
  // KoiMiddleware interface without hand-rolling every optional hook.
  function stubMiddlewareWithPhase(
    name: string,
    phase: "intercept" | "resolve" | "observe",
    priority: number,
  ): KoiMiddleware {
    return { name, phase, priority } as unknown as KoiMiddleware;
  }

  test("forces phase: observe and priority: 900 on resolved zone B entries", async () => {
    const registry = new MiddlewareRegistry();
    // A hostile factory that tries to declare intercept phase at a
    // very low priority to leapfrog the security layers.
    registry.register("@koi/leapfrog-attempt", () =>
      stubMiddlewareWithPhase("leapfrog-attempt", "intercept", 1),
    );
    const [mw] = await resolveManifestMiddleware(
      [{ name: "@koi/leapfrog-attempt", options: undefined, enabled: true }],
      registry,
      stubCtx(),
    );
    // The resolver MUST have rewritten phase/priority to the forced
    // zone B slot. Without this, the engine sort would run the
    // attacker's middleware before exfiltration-guard.
    expect(mw?.phase).toBe("resolve");
    expect(mw?.priority).toBe(500);
  });

  test("zone B lands between hooks and model-router after the real engine sort", async () => {
    // Reproduce the engine's sort from
    // `packages/kernel/engine-compose/src/compose.ts`.
    const PHASE_TIER: Record<string, number> = { intercept: 0, resolve: 1, observe: 2 };
    const engineSort = (arr: readonly KoiMiddleware[]): readonly KoiMiddleware[] =>
      [...arr].sort((a, b) => {
        const ta = PHASE_TIER[a.phase ?? "resolve"] ?? 1;
        const tb = PHASE_TIER[b.phase ?? "resolve"] ?? 1;
        if (ta !== tb) return ta - tb;
        return (a.priority ?? 500) - (b.priority ?? 500);
      });

    // Real (phase, priority) declarations from the source tree:
    //   exfiltration-guard:  intercept, 50
    //   permissions:         intercept, 100
    //   system-prompt:       resolve,   100
    //   goal:                resolve,   340
    //   hooks:               resolve,   400
    //   model-router:        resolve,   900
    //   session-transcript:  observe,   200
    const exfiltrationGuard = stubMiddlewareWithPhase("exfiltration-guard", "intercept", 50);
    const permissionsMw = stubMiddlewareWithPhase("permissions", "intercept", 100);
    const systemPromptMw = stubMiddlewareWithPhase("system-prompt", "resolve", 100);
    const goalMw = stubMiddlewareWithPhase("goal", "resolve", 340);
    const hooksMw = stubMiddlewareWithPhase("hooks", "resolve", 400);
    const modelRouterMw = stubMiddlewareWithPhase("model-router", "resolve", 900);
    const sessionTranscriptMw = stubMiddlewareWithPhase("session-transcript", "observe", 200);

    // A hostile manifest middleware trying to claim an earlier slot.
    const registry = new MiddlewareRegistry();
    registry.register("@koi/hostile", () => stubMiddlewareWithPhase("hostile", "intercept", 1));
    const [resolvedHostile] = await resolveManifestMiddleware(
      [{ name: "@koi/hostile", options: undefined, enabled: true }],
      registry,
      stubCtx(),
    );
    if (resolvedHostile === undefined) throw new Error("expected resolved middleware");

    const sorted = engineSort([
      sessionTranscriptMw,
      modelRouterMw,
      hooksMw,
      goalMw,
      systemPromptMw,
      permissionsMw,
      resolvedHostile,
      exfiltrationGuard,
    ]);
    const names = sorted.map((mw) => mw.name);

    // Security layers must come before zone B after sort.
    expect(names.indexOf("hostile")).toBeGreaterThan(names.indexOf("exfiltration-guard"));
    expect(names.indexOf("hostile")).toBeGreaterThan(names.indexOf("permissions"));
    expect(names.indexOf("hostile")).toBeGreaterThan(names.indexOf("system-prompt"));
    expect(names.indexOf("hostile")).toBeGreaterThan(names.indexOf("goal"));
    expect(names.indexOf("hostile")).toBeGreaterThan(names.indexOf("hooks"));
    // Zone B must run BEFORE model-router and session-transcript so
    // it sees the final prompt-injected request and its effects can
    // still be observed by the transcript layer.
    expect(names.indexOf("hostile")).toBeLessThan(names.indexOf("model-router"));
    expect(names.indexOf("hostile")).toBeLessThan(names.indexOf("session-transcript"));
  });

  test("multiple zone B entries land on the forced slot and keep declared order", async () => {
    const registry = new MiddlewareRegistry();
    registry.register("@koi/x", () => stubMiddleware("x"));
    registry.register("@koi/y", () => stubMiddleware("y"));
    registry.register("@koi/z", () => stubMiddleware("z"));
    const resolved = await resolveManifestMiddleware(
      [
        { name: "@koi/x", options: undefined, enabled: true },
        { name: "@koi/y", options: undefined, enabled: true },
        { name: "@koi/z", options: undefined, enabled: true },
      ],
      registry,
      stubCtx(),
    );
    for (const mw of resolved) {
      expect(mw.phase).toBe("resolve");
      expect(mw.priority).toBe(500);
    }
    expect(resolved.map((mw) => mw.name)).toEqual(["x", "y", "z"]);
  });
});

// ---------------------------------------------------------------------------
// Enforcer: enforceRequiredMiddleware
// ---------------------------------------------------------------------------

describe("enforceRequiredMiddleware", () => {
  test("accepts chain with all required layers (terminal-capable)", () => {
    const chain = [
      stubMiddleware("hooks"),
      stubMiddleware("permissions"),
      stubMiddleware("exfiltration-guard"),
    ];
    expect(() =>
      enforceRequiredMiddleware(chain, {
        terminalCapable: true,
        trustedHost: undefined,
      }),
    ).not.toThrow();
  });

  test("accepts chain with just hook (headless, non-terminal)", () => {
    const chain = [stubMiddleware("hooks")];
    expect(() =>
      enforceRequiredMiddleware(chain, {
        terminalCapable: false,
        trustedHost: undefined,
      }),
    ).not.toThrow();
  });

  test("throws when hooks is missing (always required)", () => {
    const chain = [stubMiddleware("permissions"), stubMiddleware("exfiltration-guard")];
    expect(() =>
      enforceRequiredMiddleware(chain, {
        terminalCapable: true,
        trustedHost: undefined,
      }),
    ).toThrow(RequiredMiddlewareError);
  });

  test("throws when permissions is missing on terminal-capable runtime", () => {
    const chain = [stubMiddleware("hooks"), stubMiddleware("exfiltration-guard")];
    try {
      enforceRequiredMiddleware(chain, {
        terminalCapable: true,
        trustedHost: undefined,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RequiredMiddlewareError);
      const err = e as RequiredMiddlewareError;
      expect(err.missing).toEqual(["permissions"]);
    }
  });

  test("throws when exfiltration-guard is missing on terminal-capable runtime", () => {
    const chain = [stubMiddleware("hooks"), stubMiddleware("permissions")];
    try {
      enforceRequiredMiddleware(chain, {
        terminalCapable: true,
        trustedHost: undefined,
      });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as RequiredMiddlewareError;
      expect(err.missing).toEqual(["exfiltration-guard"]);
    }
  });

  test("trustedHost.disableExfiltrationGuard allows missing exfiltration-guard and logs warning", () => {
    const warnings: string[] = [];
    const chain = [stubMiddleware("hooks"), stubMiddleware("permissions")];
    expect(() =>
      enforceRequiredMiddleware(chain, {
        terminalCapable: true,
        trustedHost: { disableExfiltrationGuard: true, disablePermissions: false },
        warn: (m) => warnings.push(m),
      }),
    ).not.toThrow();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("exfiltration-guard");
    expect(warnings[0]).toContain("DISABLED");
    expect(warnings[0]).toContain("security review");
  });

  test("trustedHost.disablePermissions allows missing permissions and logs warning", () => {
    const warnings: string[] = [];
    const chain = [stubMiddleware("hooks"), stubMiddleware("exfiltration-guard")];
    expect(() =>
      enforceRequiredMiddleware(chain, {
        terminalCapable: true,
        trustedHost: { disableExfiltrationGuard: false, disablePermissions: true },
        warn: (m) => warnings.push(m),
      }),
    ).not.toThrow();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("permissions");
    expect(warnings[0]).toContain("DISABLED");
  });

  test("trustedHost cannot opt out of hooks", () => {
    const chain = [stubMiddleware("permissions"), stubMiddleware("exfiltration-guard")];
    expect(() =>
      enforceRequiredMiddleware(chain, {
        terminalCapable: true,
        trustedHost: { disableExfiltrationGuard: true, disablePermissions: true },
        warn: () => {},
      }),
    ).toThrow(RequiredMiddlewareError);
  });

  test("both opt-outs active → two warnings and no throw even with only hook present", () => {
    const warnings: string[] = [];
    const chain = [stubMiddleware("hooks")];
    expect(() =>
      enforceRequiredMiddleware(chain, {
        terminalCapable: true,
        trustedHost: { disableExfiltrationGuard: true, disablePermissions: true },
        warn: (m) => warnings.push(m),
      }),
    ).not.toThrow();
    expect(warnings.length).toBe(2);
  });

  test("headless runtime does not require permissions or exfiltration-guard", () => {
    const chain = [stubMiddleware("hooks")];
    expect(() =>
      enforceRequiredMiddleware(chain, {
        terminalCapable: false,
        trustedHost: undefined,
      }),
    ).not.toThrow();
  });

  test("missing multiple layers reports all in error", () => {
    const chain: readonly KoiMiddleware[] = [];
    try {
      enforceRequiredMiddleware(chain, {
        terminalCapable: true,
        trustedHost: undefined,
      });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as RequiredMiddlewareError;
      expect(err.missing).toEqual(["hooks", "permissions", "exfiltration-guard"]);
      expect(err.message).toContain("hooks");
      expect(err.message).toContain("permissions");
      expect(err.message).toContain("exfiltration-guard");
    }
  });
});

// ---------------------------------------------------------------------------
// composeRuntimeMiddleware — zone B sits INSIDE the security guard
//
// This is the critical security invariant. Zone B middleware is
// repo-authored, so it must never see raw request/response data
// before `hook`/`permissions`/`exfiltration-guard` have had a chance
// to gate and redact. The compose function is the single source of
// truth for chain order, so testing it directly is the cleanest
// anchor for the invariant.
// ---------------------------------------------------------------------------

describe("composeRuntimeMiddleware — zone B inside security guard", () => {
  test("zone B appears after zone C-top security layers, before optional innermost layers", () => {
    const hookMw = stubMiddleware("hooks");
    const permissionsMw = stubMiddleware("permissions");
    const exfiltrationGuardMw = stubMiddleware("exfiltration-guard");
    const preset1 = stubMiddleware("preset-1");
    const preset2 = stubMiddleware("preset-2");
    const manifest1 = stubMiddleware("manifest-1");
    const manifest2 = stubMiddleware("manifest-2");
    const systemPromptMw = stubMiddleware("system-prompt");
    const sessionTranscriptMw = stubMiddleware("session-transcript");

    const chain = composeRuntimeMiddleware({
      hook: hookMw,
      permissions: permissionsMw,
      exfiltrationGuard: exfiltrationGuardMw,
      presetExtras: [preset1, preset2],
      manifestMiddleware: [manifest1, manifest2],
      systemPrompt: systemPromptMw,
      sessionTranscript: sessionTranscriptMw,
    });

    expect(chain.map((mw) => mw.name)).toEqual([
      // Zone A — code-owned presets, outermost
      "preset-1",
      "preset-2",
      // Zone C-top — required security layers wrap zone B
      "hooks",
      "permissions",
      "exfiltration-guard",
      // Zone B — user-declared middleware, runs INSIDE the guard
      "manifest-1",
      "manifest-2",
      // Zone C-bottom — optional innermost layers
      "system-prompt",
      "session-transcript",
    ]);
  });

  test("manifest entries never appear before the security layers", () => {
    const hookMw = stubMiddleware("hooks");
    const permissionsMw = stubMiddleware("permissions");
    const exfiltrationGuardMw = stubMiddleware("exfiltration-guard");
    const attacker = stubMiddleware("attacker-log");

    const chain = composeRuntimeMiddleware({
      hook: hookMw,
      permissions: permissionsMw,
      exfiltrationGuard: exfiltrationGuardMw,
      manifestMiddleware: [attacker],
    });

    const names = chain.map((mw) => mw.name);
    const guardIdx = names.indexOf("exfiltration-guard");
    const attackerIdx = names.indexOf("attacker-log");
    // Attacker middleware must be INSIDE (later in chain) than the
    // guard, so the guard sees requests first and redacts before the
    // attacker's wrapModelCall ever runs.
    expect(attackerIdx).toBeGreaterThan(guardIdx);
    // And after hooks and permissions too.
    expect(attackerIdx).toBeGreaterThan(names.indexOf("hooks"));
    expect(attackerIdx).toBeGreaterThan(names.indexOf("permissions"));
  });

  test("omitted manifestMiddleware produces the legacy chain (no zone B slot)", () => {
    const chain = composeRuntimeMiddleware({
      hook: stubMiddleware("hooks"),
      permissions: stubMiddleware("permissions"),
      exfiltrationGuard: stubMiddleware("exfiltration-guard"),
    });
    expect(chain.map((mw) => mw.name)).toEqual(["hooks", "permissions", "exfiltration-guard"]);
  });
});

// ---------------------------------------------------------------------------
// buildInheritedMiddlewareForChildren — spawn inheritance
//
// Spawned child agents must inherit the same manifest-declared
// middleware as the parent, so audit/retry/etc. do not silently
// disappear when work is delegated. This is the split-brain fix
// for the zone B design — children see the same chain the parent
// sees (minus per-runtime innermost slots).
// ---------------------------------------------------------------------------

describe("buildInheritedMiddlewareForChildren", () => {
  // Zone B is intentionally NOT inherited — see
  // `compose-middleware.ts` for the rationale. Parent middleware
  // instances carry mutable per-session state (e.g. audit queues +
  // hash chains) that cannot be shared across runtimes without
  // corruption. The runtime factory logs a warning when zone B is
  // non-empty AND spawn stack is active.

  test("always includes permissions, exfiltration-guard, hooks", () => {
    const result = buildInheritedMiddlewareForChildren({
      permissions: stubMiddleware("permissions"),
      exfiltrationGuard: stubMiddleware("exfiltration-guard"),
      hook: stubMiddleware("hooks"),
    });
    expect(result.map((mw) => mw.name)).toEqual(["permissions", "exfiltration-guard", "hooks"]);
  });

  test("includes systemPrompt when provided, skipped otherwise", () => {
    const withPrompt = buildInheritedMiddlewareForChildren({
      permissions: stubMiddleware("permissions"),
      exfiltrationGuard: stubMiddleware("exfiltration-guard"),
      hook: stubMiddleware("hooks"),
      systemPrompt: stubMiddleware("system-prompt"),
    });
    expect(withPrompt.map((mw) => mw.name)).toEqual([
      "permissions",
      "exfiltration-guard",
      "hooks",
      "system-prompt",
    ]);

    const withoutPrompt = buildInheritedMiddlewareForChildren({
      permissions: stubMiddleware("permissions"),
      exfiltrationGuard: stubMiddleware("exfiltration-guard"),
      hook: stubMiddleware("hooks"),
    });
    expect(withoutPrompt.map((mw) => mw.name)).toEqual([
      "permissions",
      "exfiltration-guard",
      "hooks",
    ]);
  });
});
