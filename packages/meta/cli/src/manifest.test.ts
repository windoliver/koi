import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifestConfig, revalidateAuditPathContainment } from "./manifest.js";

// Regression tests for #1777 — manifest.filesystem must be parsed,
// validated, and surfaced so `koi start --manifest` / `koi tui --manifest`
// can wire alternate filesystem backends instead of silently falling
// through to the default local backend.

describe("loadManifestConfig: codeSandbox block (#1550)", () => {
  let dir: string;
  const writeManifest = (yaml: string): string => {
    const p = join(dir, "koi.manifest.yaml");
    writeFileSync(p, yaml);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "koi-manifest-1550-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects subprocess until a filesystem-confined provider is implemented", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "codeSandbox:",
        "  provider: subprocess",
      ].join("\n"),
    );

    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("No codeSandbox providers are currently supported");
  });

  test("rejects missing provider", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "codeSandbox:",
        "  image: python:3.12-slim",
      ].join("\n"),
    );

    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("manifest.codeSandbox.provider");
  });

  test("rejects unsupported provider", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "codeSandbox:", "  provider: docker"].join(
        "\n",
      ),
    );

    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("No codeSandbox providers are currently supported");
  });

  test("rejects unsupported backend options", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "codeSandbox:",
        "  provider: subprocess",
        "  image: python:3.12-slim",
      ].join("\n"),
    );

    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('unknown key "image"');
  });
});

describe("loadManifestConfig: filesystem block", () => {
  let dir: string;
  const writeManifest = (yaml: string): string => {
    const p = join(dir, "koi.manifest.yaml");
    writeFileSync(p, yaml);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "koi-manifest-1777-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("omits filesystem when block absent", async () => {
    const p = writeManifest(["model:", "  name: google/gemini-2.0-flash-001"].join("\n"));
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filesystem).toBeUndefined();
  });

  test("parses filesystem.backend: local", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "filesystem:", "  backend: local"].join(
        "\n",
      ),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filesystem).toEqual({ backend: "local" });
  });

  test("parses filesystem.backend: nexus with absolute local bridge options", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "filesystem:",
        "  backend: nexus",
        "  options:",
        "    transport: local",
        '    mountUri: "local:///tmp/koi-test-mount"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filesystem).toEqual({
      backend: "nexus",
      options: {
        transport: "local",
        // Absolute `local:///...` passes through unchanged.
        mountUri: "local:///tmp/koi-test-mount",
      },
    });
  });

  test("rejects invalid filesystem.backend enum", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "filesystem:",
        "  backend: quantum-drive",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("filesystem");
    expect(result.error).toContain("backend");
  });

  test("rejects filesystem with unknown top-level key", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "filesystem:",
        "  backend: local",
        "  unknownKey: 1",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.toLowerCase()).toContain("filesystem");
  });

  test("anchors relative local:// mountUri to the manifest directory, not process.cwd", async () => {
    // Regression for #1777 round 3: a shared manifest checked into repo A
    // must not silently target repo B when `koi start` is launched from
    // a different shell cwd. Relative `local://./path` resolves against
    // the manifest file's directory, not `process.cwd()`.
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "filesystem:",
        "  backend: nexus",
        "  options:",
        "    transport: local",
        '    mountUri: "local://./workspace"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const options = (result.value.filesystem?.options ?? {}) as Record<string, unknown>;
    const mountUri = options.mountUri as string;
    expect(mountUri.startsWith("local:///")).toBe(true);
    expect(mountUri).toContain("/workspace");
    // The anchor must be the manifest directory (a temp dir), not the
    // test runner's cwd.
    expect(mountUri).toContain(dir);
    expect(mountUri).not.toBe("local://./workspace");
  });

  test("anchors single-entry array mountUri", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "filesystem:",
        "  backend: nexus",
        "  options:",
        "    transport: local",
        "    mountUri:",
        '      - "local://./a"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const options = (result.value.filesystem?.options ?? {}) as Record<string, unknown>;
    const mountUri = options.mountUri as readonly string[];
    expect(mountUri[0]).toContain(`${dir}/a`);
  });

  test("rejects multi-mount arrays (runtime does not support them yet)", async () => {
    // Regression for #1777 round 9: the runtime `resolveFileSystemAsync`
    // throws on multi-mount local-bridge configs. Fail fast at parse
    // time instead of at runtime assembly.
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "filesystem:",
        "  backend: nexus",
        "  options:",
        "    transport: local",
        "    mountUri:",
        '      - "local:///tmp/a"',
        '      - "local:///tmp/b"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.toLowerCase()).toContain("multi-mount");
  });

  test("rejects non-local:// mountUri schemes (OAuth gate)", async () => {
    // Regression for #1777 round 7: OAuth-requiring connector schemes
    // must be rejected at parse time, not silently accepted and then
    // aborting the session on first filesystem call.
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "filesystem:",
        "  backend: nexus",
        "  options:",
        "    transport: local",
        '    mountUri: "gdrive://my-drive"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("gdrive://my-drive");
    expect(result.error).toContain("local://");
  });

  test("rejects array mountUri containing unsupported scheme", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "filesystem:",
        "  backend: nexus",
        "  options:",
        "    transport: local",
        "    mountUri:",
        '      - "s3://bucket/key"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("s3://bucket/key");
  });

  test("allows multi-mount arrays for TUI OAuth-aware manifest loads", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "filesystem:",
        "  backend: nexus",
        "  options:",
        "    transport: local",
        "    mountUri:",
        '      - "local:///tmp/a"',
        '      - "local:///tmp/b"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p, { allowOAuthSchemes: true });
    expect(result.ok).toBe(true);
  });

  test("allows OAuth-backed mountUri schemes for TUI OAuth-aware manifest loads", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "filesystem:",
        "  backend: nexus",
        "  options:",
        "    transport: local",
        '    mountUri: "gdrive://my-drive"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p, { allowOAuthSchemes: true });
    expect(result.ok).toBe(true);
  });

  test("rejects filesystem that is not an object", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "filesystem: nope"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.toLowerCase()).toContain("filesystem");
  });
});

// gov-10: manifest.governance section — feeds the same fields as the CLI
// flags so both sources converge on the same runtime-factory shape. CLI
// flags win at merge time; the loader only validates here.
describe("loadManifestConfig: governance block (gov-10)", () => {
  let dir: string;
  const writeManifest = (yaml: string): string => {
    const p = join(dir, "koi.manifest.yaml");
    writeFileSync(p, yaml);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "koi-manifest-gov10-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("omits governance when block absent", async () => {
    const p = writeManifest(["model:", "  name: google/gemini-2.0-flash-001"].join("\n"));
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.governance).toBeUndefined();
  });

  test("parses full governance block", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "governance:",
        "  maxSpend: 2.50",
        "  maxTurns: 50",
        "  maxSpawnDepth: 3",
        '  policyFile: "/abs/policies/default.yaml"',
        "  alertThresholds: [0.7, 0.9]",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.governance).toEqual({
      maxSpend: 2.5,
      maxTurns: 50,
      maxSpawnDepth: 3,
      policyFile: "/abs/policies/default.yaml",
      alertThresholds: [0.7, 0.9],
    });
  });

  test("anchors relative policyFile to manifest dir", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "governance:",
        "  policyFile: ./policies/default.yaml",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.governance?.policyFile).toBe(join(dir, "policies/default.yaml"));
  });

  test("rejects negative maxSpend", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "governance:", "  maxSpend: -1"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("maxSpend");
  });

  test("rejects non-integer maxTurns", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "governance:", "  maxTurns: 10.5"].join(
        "\n",
      ),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("maxTurns");
  });

  test("rejects alertThreshold outside (0, 1]", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "governance:",
        "  alertThresholds: [0.5, 1.5]",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("alertThresholds");
  });

  test("rejects non-object governance block", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "governance: foo"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("governance");
  });
});

describe("loadManifestConfig: supervision block", () => {
  let dir: string;
  const writeManifest = (yaml: string): string => {
    const p = join(dir, "koi.manifest.yaml");
    writeFileSync(p, yaml);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "koi-manifest-supervision-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("omits supervision when block absent", async () => {
    const p = writeManifest(["model:", "  name: google/gemini-2.0-flash-001"].join("\n"));
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.supervision).toBeUndefined();
  });

  test("parses full supervision block with explicit strategy object", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "supervision:",
        "  strategy: { kind: one_for_one }",
        "  maxRestarts: 3",
        "  maxRestartWindowMs: 30000",
        "  children:",
        "    - name: worker-a",
        "      restart: permanent",
        "      isolation: in-process",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.supervision).toEqual({
      strategy: { kind: "one_for_one" },
      maxRestarts: 3,
      maxRestartWindowMs: 30000,
      children: [{ name: "worker-a", restart: "permanent", isolation: "in-process" }],
    });
  });

  test("accepts bare-string strategy shortcut", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "supervision:",
        "  strategy: one_for_all",
        "  children:",
        "    - name: a",
        "      restart: transient",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.supervision?.strategy).toEqual({ kind: "one_for_all" });
    // Defaults: maxRestarts=5, maxRestartWindowMs=60000
    expect(result.value.supervision?.maxRestarts).toBe(5);
    expect(result.value.supervision?.maxRestartWindowMs).toBe(60_000);
  });

  test("rejects unknown strategy", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "supervision:",
        "  strategy: bogus",
        "  children: []",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("strategy");
  });

  test("rejects unknown restart type", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "supervision:",
        "  strategy: one_for_one",
        "  children:",
        "    - name: w",
        "      restart: forever",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("restart");
  });

  test("rejects duplicate child names (validator catches it)", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "supervision:",
        "  strategy: one_for_one",
        "  children:",
        "    - name: dup",
        "      restart: permanent",
        "    - name: dup",
        "      restart: permanent",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("duplicate");
  });

  test("rejects non-object supervision block", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "supervision: not-an-object"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("supervision");
  });
});

describe("loadManifestConfig: audit block (#1994)", () => {
  let dir: string;
  let logsDir: string;
  const writeManifest = (yaml: string): string => {
    const p = join(dir, "koi.manifest.yaml");
    writeFileSync(p, yaml);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "koi-manifest-audit-"));
    // Most path-anchoring tests reference ./logs/ — create it so the parent-
    // existence check passes. Tests covering missing parents use different paths.
    logsDir = join(dir, "logs");
    mkdirSync(logsDir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("omits audit when block absent", async () => {
    const p = writeManifest(["model:", "  name: google/gemini-2.0-flash-001"].join("\n"));
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.audit).toBeUndefined();
  });

  test("rejects absolute paths (manifest content must not write to arbitrary host locations)", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "audit:",
        '  ndjson: "/abs/logs/audit.ndjson"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ndjson");
    expect(result.error).toContain("absolute");
  });

  test("anchors relative paths to manifest dir", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "audit:",
        "  ndjson: ./logs/session.audit.ndjson",
        "  sqlite: logs/session.audit.db",
        "  violations: ./logs/session.violations.db",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.audit?.ndjson).toBe(join(dir, "logs/session.audit.ndjson"));
    expect(result.value.audit?.sqlite).toBe(join(dir, "logs/session.audit.db"));
    expect(result.value.audit?.violations).toBe(join(dir, "logs/session.violations.db"));
  });

  test("parses partial audit block (ndjson only)", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "audit:",
        "  ndjson: ./logs/session.audit.ndjson",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.audit?.ndjson).toBe(join(dir, "logs/session.audit.ndjson"));
    expect(result.value.audit?.sqlite).toBeUndefined();
    expect(result.value.audit?.violations).toBeUndefined();
  });

  test("returns non-undefined audit with present:true when block is empty", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "audit: {}"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Empty block: present:true, all paths undefined
    expect(result.value.audit).not.toBeUndefined();
    expect(result.value.audit?.present).toBe(true);
    expect(result.value.audit?.ndjson).toBeUndefined();
    expect(result.value.audit?.sqlite).toBeUndefined();
    expect(result.value.audit?.violations).toBeUndefined();
  });

  test("rejects unknown keys in strict mode (catches typos)", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "audit:", "  sqltie: ./logs/audit.db"].join(
        "\n",
      ),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("sqltie");
  });

  test("marks malformed:true for unknown keys in lenient mode without fabricating unrelated sentinels", async () => {
    // A typo'd key (sqltie instead of sqlite) must not block startup, but it
    // signals attempted audit configuration. The malformed flag lets tui-command
    // emit a clear "fix the manifest" error instead of requiring unrelated
    // KOI_AUDIT_* overrides for sinks the author never configured.
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "audit:", "  sqltie: ./logs/audit.db"].join(
        "\n",
      ),
    );
    const result = await loadManifestConfig(p, { skipAuditValidation: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.audit?.present).toBe(true);
    expect(result.value.audit?.malformed).toBe(true);
    // Unknown key only (no known keys) → all three remain undefined.
    expect(result.value.audit?.ndjson).toBeUndefined();
    expect(result.value.audit?.sqlite).toBeUndefined();
    expect(result.value.audit?.violations).toBeUndefined();
  });

  test("marks malformed:true for non-object audit block in lenient mode", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "audit: not-an-object"].join("\n"),
    );
    const result = await loadManifestConfig(p, { skipAuditValidation: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.audit?.present).toBe(true);
    expect(result.value.audit?.malformed).toBe(true);
    expect(result.value.audit?.ndjson).toBeUndefined();
  });

  test("rejects non-object audit block", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "audit: not-an-object"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("audit");
  });

  test("rejects empty string ndjson path", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "audit:", '  ndjson: ""'].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ndjson");
  });

  test("rejects non-string sqlite path", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "audit:", "  sqlite: 42"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("sqlite");
  });

  test("accepts path in a directory whose name starts with '..' (not a traversal)", async () => {
    // e.g. '..logs' is a valid directory name — startsWith("..") is not sufficient
    // to detect a real ".." path segment. Only `../<rest>` is a traversal.
    const dotDotDir = join(dir, "..logs");
    mkdirSync(dotDotDir);
    const _p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "audit:",
        "  ndjson: ../..logs/session.audit.ndjson",
      ].join("\n"),
    );
    // This still escapes because it traverses OUT of dir first, even if target
    // starts with "..". The point of this test is the fix works for names like
    // "..logs/" that are truly inside the manifest dir (not via ".." segments).
    // Use a path that really IS inside dir:
    const p2 = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "audit:",
        "  ndjson: ..logs/session.audit.ndjson",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.audit?.ndjson).toBe(join(dotDotDir, "session.audit.ndjson"));
  });

  test("rejects `..` traversal out of the manifest directory", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "audit:",
        "  ndjson: ../outside/audit.ndjson",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ndjson");
    expect(result.error).toContain("..");
  });

  test("rejects path whose parent is a symlink escaping the manifest dir", async () => {
    // Use a different directory name (sinks/) so it does not collide with the
    // logs/ directory pre-created in beforeEach.
    const externalDir = mkdtempSync(join(tmpdir(), "koi-audit-external-"));
    try {
      const sinksLink = join(dir, "sinks");
      symlinkSync(externalDir, sinksLink);
      const p = writeManifest(
        [
          "model:",
          "  name: google/gemini-2.0-flash-001",
          "audit:",
          "  sqlite: sinks/session.audit.db",
        ].join("\n"),
      );
      const result = await loadManifestConfig(p);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("sqlite");
      expect(result.error).toContain("symlink");
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  test("rejects path that is itself a symlink", async () => {
    // logs/ is pre-created in beforeEach; place a symlink file inside it.
    const externalDir = mkdtempSync(join(tmpdir(), "koi-audit-external-"));
    try {
      const externalFile = join(externalDir, "session.audit.db");
      writeFileSync(externalFile, "");
      const fileLink = join(logsDir, "session.audit.db");
      symlinkSync(externalFile, fileLink);
      const p = writeManifest(
        [
          "model:",
          "  name: google/gemini-2.0-flash-001",
          "audit:",
          "  sqlite: logs/session.audit.db",
        ].join("\n"),
      );
      const result = await loadManifestConfig(p);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("sqlite");
      expect(result.error).toContain("symlink");
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  test("rejects ndjson path without required .audit.ndjson suffix (prevents targeting arbitrary files)", async () => {
    // e.g. pointing at package.json or a source file
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "audit:",
        "  ndjson: ./logs/audit.log",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ndjson");
    expect(result.error).toContain(".audit.ndjson");
  });

  test("rejects sqlite path without required .audit.db suffix", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "audit:",
        "  sqlite: ./logs/data.sqlite",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("sqlite");
    expect(result.error).toContain(".audit.db");
  });

  test("rejects ndjson path whose parent directory does not exist", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "audit:",
        "  ndjson: ./missing-dir/session.audit.ndjson",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ndjson");
    expect(result.error).toContain("does not exist");
  });

  test("rejects sqlite path whose parent directory does not exist", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "audit:",
        "  sqlite: ./missing-dir/session.audit.db",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("sqlite");
    expect(result.error).toContain("does not exist");
  });

  test("returns error (not throw) when parent directory is a symlink loop (ELOOP)", async () => {
    // Create a circular symlink: loop → loop inside logs/. realpathSync on any
    // path through it produces ELOOP. parseManifestAudit must return { ok: false }
    // instead of propagating the exception to the caller.
    const loopLink = join(dir, "logs", "loop");
    symlinkSync(loopLink, loopLink); // points to itself
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "audit:",
        "  ndjson: ./logs/loop/session.audit.ndjson",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ndjson");
  });

  test("rejects ndjson path that is a hard link (nlink > 1)", async () => {
    // Hard links share an inode with their target. A file inside the manifest
    // tree could be a hard link to a file outside it — containment checks pass
    // because the parent directory is safe, but writes reach the outside inode.
    const externalFile = join(dir, "outside.audit.ndjson");
    writeFileSync(externalFile, "");
    const hardLink = join(dir, "logs", "session.audit.ndjson");
    linkSync(externalFile, hardLink);
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "audit:",
        "  ndjson: ./logs/session.audit.ndjson",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ndjson");
    expect(result.error).toContain("hard link");
  });
});

describe("revalidateAuditPathContainment", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "koi-revalidate-"));
    mkdirSync(join(dir, "logs"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const manifestPath = (): string => join(dir, "koi.manifest.yaml");

  test("returns undefined when path is safe", () => {
    const resolvedPath = join(dir, "logs", "session.audit.ndjson");
    writeFileSync(manifestPath(), "");
    const result = revalidateAuditPathContainment(resolvedPath, manifestPath());
    expect(result).toBeUndefined();
  });

  test("returns error string (not throw) when parent is a symlink loop (ELOOP)", () => {
    const loopLink = join(dir, "logs", "loop");
    symlinkSync(loopLink, loopLink);
    writeFileSync(manifestPath(), "");
    const result = revalidateAuditPathContainment(
      join(loopLink, "session.audit.ndjson"),
      manifestPath(),
    );
    expect(typeof result).toBe("string");
    expect(result).not.toBeUndefined();
  });

  test("returns error string when path resolves through symlink outside manifest dir", () => {
    const externalDir = mkdtempSync(join(tmpdir(), "koi-external-"));
    try {
      const escapeLink = join(dir, "logs", "escape");
      symlinkSync(externalDir, escapeLink);
      writeFileSync(manifestPath(), "");
      const result = revalidateAuditPathContainment(
        join(escapeLink, "session.audit.ndjson"),
        manifestPath(),
      );
      expect(typeof result).toBe("string");
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  test("returns error string when path is now a symlink", () => {
    const target = join(dir, "logs", "actual.audit.ndjson");
    writeFileSync(target, "");
    const linkPath = join(dir, "logs", "session.audit.ndjson");
    symlinkSync(target, linkPath);
    writeFileSync(manifestPath(), "");
    const result = revalidateAuditPathContainment(linkPath, manifestPath());
    expect(typeof result).toBe("string");
    expect(result).toContain("symlink");
  });

  test("returns error string when path is now a hard link (nlink > 1)", () => {
    const externalFile = join(dir, "outside.ndjson");
    writeFileSync(externalFile, "");
    const hardLink = join(dir, "logs", "session.audit.ndjson");
    linkSync(externalFile, hardLink);
    writeFileSync(manifestPath(), "");
    const result = revalidateAuditPathContainment(hardLink, manifestPath());
    expect(typeof result).toBe("string");
    expect(result).toContain("hard link");
  });
});

// Issue #2088: ACE manifest schema. Activation is gated in the host
// (runtime-factory + commands/start) — this block exercises the parser only.
describe("loadManifestConfig: ace block (#2088)", () => {
  let dir: string;
  const writeManifest = (yaml: string): string => {
    const p = join(dir, "koi.manifest.yaml");
    writeFileSync(p, yaml);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "koi-manifest-ace-2088-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("omits ace when block absent", async () => {
    const p = writeManifest(["model:", "  name: google/gemini-2.0-flash-001"].join("\n"));
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ace).toBeUndefined();
  });

  test("parses enabled: false as a valid no-op", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "ace:", "  enabled: false"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ace).toEqual({
      enabled: false,
      acknowledgeCrossSessionState: false,
      maxInjectedTokens: undefined,
      minScore: undefined,
      lambda: undefined,
      playbookPath: undefined,
    });
  });

  test("parses full block with all overrides", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        "  acknowledge_cross_session_state: true",
        "  max_injected_tokens: 800",
        "  min_score: 0.05",
        "  lambda: 0.07",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ace).toEqual({
      enabled: true,
      acknowledgeCrossSessionState: true,
      maxInjectedTokens: 800,
      minScore: 0.05,
      lambda: 0.07,
      playbookPath: undefined,
    });
  });

  test("parses partial block (only enabled + min_score)", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        "  acknowledge_cross_session_state: true",
        "  min_score: 0.1",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ace).toEqual({
      enabled: true,
      acknowledgeCrossSessionState: true,
      maxInjectedTokens: undefined,
      minScore: 0.1,
      lambda: undefined,
      playbookPath: undefined,
    });
  });

  test("rejects unknown key with helpful message", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        "  acknowledge_cross_session_state: true",
        "  bogus_key: 1",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("manifest.ace: unknown key");
    expect(result.error).toContain("bogus_key");
  });

  test("rejects absolute playbook_path (trust boundary)", async () => {
    // A repo-controlled manifest must not be able to point the SQLite store at
    // arbitrary filesystem locations: createSqlitePlaybookStore eagerly
    // creates parent dirs and opens with create:true.
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        "  acknowledge_cross_session_state: true",
        "  playbook_path: /tmp/koi-ace.sqlite",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("manifest.ace.playbook_path");
    expect(result.error).toContain("relative to the manifest directory");
  });

  test("rejects symlink-escape that lexically stays inside manifest dir", async () => {
    // A repo could check in `escape -> /tmp` and a manifest with
    // `playbook_path: ./escape/x.sqlite`. The lexical path stays under
    // manifestDir but the realpath points outside. Containment must be
    // symlink-aware.
    const { mkdtempSync, symlinkSync } = await import("node:fs");
    const outerDir = mkdtempSync(join(tmpdir(), "koi-symlink-outer-"));
    try {
      symlinkSync(outerDir, join(dir, "escape"));
      const p = writeManifest(
        [
          "model:",
          "  name: google/gemini-2.0-flash-001",
          "ace:",
          "  enabled: true",
          "  acknowledge_cross_session_state: true",
          "  playbook_path: ./escape/x.sqlite",
        ].join("\n"),
      );
      const result = await loadManifestConfig(p);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("symlink-aware");
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(outerDir, { recursive: true, force: true });
    }
  });

  test("rejects relative playbook_path that escapes the manifest dir", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        "  acknowledge_cross_session_state: true",
        "  playbook_path: ../escape.sqlite",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must resolve inside the manifest directory");
  });

  test("anchors relative playbook_path against manifest dir", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        "  acknowledge_cross_session_state: true",
        "  playbook_path: ./.koi/ace.sqlite",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Path is symlink-resolved; on macOS tmpdir contains /private prefix.
    const { realpathSync } = await import("node:fs");
    expect(result.value.ace?.playbookPath).toBe(`${realpathSync(dir)}/.koi/ace.sqlite`);
  });

  test("accepts :memory: sentinel verbatim", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        "  acknowledge_cross_session_state: true",
        '  playbook_path: ":memory:"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ace?.playbookPath).toBe(":memory:");
  });

  test("rejects empty playbook_path", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        "  acknowledge_cross_session_state: true",
        '  playbook_path: ""',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("manifest.ace.playbook_path");
  });

  test("rejects non-boolean enabled", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "ace:", '  enabled: "yes"'].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("manifest.ace.enabled must be a boolean");
  });

  test("accepts max_injected_tokens: 0 (no-injection mode in runtime)", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        "  acknowledge_cross_session_state: true",
        "  max_injected_tokens: 0",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ace?.maxInjectedTokens).toBe(0);
  });

  test("rejects negative max_injected_tokens", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        "  acknowledge_cross_session_state: true",
        "  max_injected_tokens: -1",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("manifest.ace.max_injected_tokens must be >= 0");
  });

  test("rejects min_score outside [0, 1]", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        "  acknowledge_cross_session_state: true",
        "  min_score: 1.5",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("manifest.ace.min_score must be in [0, 1]");
  });

  test("accepts lambda: 0 (disables recency decay in runtime)", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        "  acknowledge_cross_session_state: true",
        "  lambda: 0",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ace?.lambda).toBe(0);
  });

  test("rejects negative lambda", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        "  acknowledge_cross_session_state: true",
        "  lambda: -0.01",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("manifest.ace.lambda must be >= 0");
  });

  test("rejects enabled: true without acknowledge_cross_session_state", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "ace:", "  enabled: true"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("acknowledge_cross_session_state: true");
    expect(result.error).toContain("survive conversation resets");
  });

  test("rejects non-boolean acknowledge_cross_session_state", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "ace:",
        "  enabled: true",
        '  acknowledge_cross_session_state: "yes"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(
      "manifest.ace.acknowledge_cross_session_state must be a boolean",
    );
  });

  test("rejects non-object ace block", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "ace: true"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("manifest.ace must be an object");
  });

  test("defaults enabled to false when key omitted", async () => {
    // `ace: {}` is equivalent to no enable signal.
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "ace: {}"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ace).toEqual({
      enabled: false,
      acknowledgeCrossSessionState: false,
      maxInjectedTokens: undefined,
      minScore: undefined,
      lambda: undefined,
      playbookPath: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// network block (gov-15) — outbound URL scope
// ---------------------------------------------------------------------------

describe("loadManifestConfig: network block (gov-15)", () => {
  let dir: string;
  const writeManifest = (yaml: string): string => {
    const p = join(dir, "koi.manifest.yaml");
    writeFileSync(p, yaml);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "koi-manifest-gov15-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("omits network when block absent", async () => {
    const p = writeManifest(["model:", "  name: google/gemini-2.0-flash-001"].join("\n"));
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.network).toBeUndefined();
  });

  test("parses network.allow with one entry", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "network:",
        "  allow:",
        '    - "https://api.example.com/*"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.network).toEqual({ allow: ["https://api.example.com/*"] });
  });

  test("parses network.allow with multiple entries", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "network:",
        "  allow:",
        '    - "https://api.example.com/*"',
        '    - "https://*.public.example/*"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.network?.allow.length).toBe(2);
  });

  test("preserves empty allow array as deny-all (not undefined)", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "network:", "  allow: []"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // gov-15: explicit empty allow is preserved so downstream wiring
    // builds a deny-all URLPattern allowlist (createScopedFetcher with
    // allow: [] throws on every URL). Collapsing to undefined would
    // silently revert to legacy unscoped behavior, which is the wrong
    // default for an explicit empty manifest declaration.
    expect(result.value.network).toEqual({ allow: [] });
  });

  test("rejects non-string allow entries", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "network:", "  allow:", "    - 123"].join(
        "\n",
      ),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("non-empty strings");
  });

  test("rejects malformed URLPattern entries", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "network:",
        "  allow:",
        '    - "://broken"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not a valid URLPattern");
  });

  test("rejects network as a non-object", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "network: yes"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("manifest.network");
  });

  test("rejects network block missing allow (typo guard)", async () => {
    // gov-15: same fail-closed parser strictness as credentials — a typo
    // like `allowed:` must not silently load as "no scope".
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "network:",
        "  allowed:",
        '    - "https://example.com/*"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not a recognized key");
  });

  test("rejects network block with no allow field", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "network: {}"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must declare an `allow`");
  });
});

// ---------------------------------------------------------------------------
// credentials block (gov-15) — credential key glob scope
// ---------------------------------------------------------------------------

describe("loadManifestConfig: credentials block (gov-15)", () => {
  let dir: string;
  const writeManifest = (yaml: string): string => {
    const p = join(dir, "koi.manifest.yaml");
    writeFileSync(p, yaml);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "koi-manifest-gov15-creds-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("omits credentials when block absent", async () => {
    const p = writeManifest(["model:", "  name: google/gemini-2.0-flash-001"].join("\n"));
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.credentials).toBeUndefined();
  });

  test("parses credentials.allow with one entry", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "credentials:",
        "  allow:",
        '    - "openai_*"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.credentials).toEqual({ allow: ["openai_*"] });
  });

  test("parses credentials.allow with multiple entries", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "credentials:",
        "  allow:",
        '    - "openai_*"',
        '    - "anthropic_*"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.credentials?.allow.length).toBe(2);
  });

  test("preserves empty allow array as deny-all (not undefined)", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "credentials:", "  allow: []"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // gov-15: explicit `credentials: { allow: [] }` means deny all, not
    // legacy "no scope". The downstream wiring must build a deny-all
    // CredentialComponent so out-of-scope skills are gated and
    // authed_fetch rejects every key.
    expect(result.value.credentials).toEqual({ allow: [] });
  });

  test("rejects non-string allow entries", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "credentials:",
        "  allow:",
        "    - 42",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("non-empty strings");
  });

  test("rejects credentials as a non-object", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "credentials: yes"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("manifest.credentials");
  });

  test("rejects credentials block missing allow (typo guard)", async () => {
    // gov-15: a present `credentials:` block must declare `allow`. Loading
    // it as `undefined → unscoped` would turn an operator typo
    // (`allowed:` instead of `allow:`) into legacy open-mode credential
    // access — the exact bypass this feature is closing.
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "credentials:",
        "  allowed:",
        '    - "openai_*"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not a recognized key");
  });

  test("rejects credentials block with no fields at all", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "credentials: {}"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must declare an `allow`");
  });

  test("rejects allow as non-array", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "credentials:", '  allow: "openai_*"'].join(
        "\n",
      ),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must be an array");
  });
});

describe("loadManifestConfig: nexus block (#1403)", () => {
  let dir: string;
  const writeManifest = (yaml: string): string => {
    const p = join(dir, "koi.manifest.yaml");
    writeFileSync(p, yaml);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "koi-manifest-nexus-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("omits nexus when block absent", async () => {
    const p = writeManifest(["model:", "  name: google/gemini-2.0-flash-001"].join("\n"));
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nexus).toBeUndefined();
  });

  test("defaults mode to 'auto' when nexus block is empty", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "nexus: {}"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nexus?.mode).toBe("auto");
  });

  test("parses sandbox mode with port + dataDir", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "nexus:",
        "  mode: sandbox",
        "  port: 2026",
        "  dataDir: /tmp/nexus",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nexus).toEqual({
      mode: "sandbox",
      url: undefined,
      port: 2026,
      dataDir: "/tmp/nexus",
      enableVectorSearch: undefined,
      embeddingModel: undefined,
    });
  });

  test("parses external mode with url", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "nexus:",
        "  mode: external",
        "  url: http://nexus.example.com",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nexus?.mode).toBe("external");
    expect(result.value.nexus?.url).toBe("http://nexus.example.com");
  });

  test("rejects unknown mode", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "nexus:", "  mode: docker"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("auto");
  });

  test("rejects url with sandbox mode", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "nexus:",
        "  mode: sandbox",
        "  url: http://x",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("sandbox");
  });

  test("rejects unknown field", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "nexus:",
        "  mode: sandbox",
        "  bogus: 1",
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("bogus");
  });

  test("rejects out-of-range port", async () => {
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "nexus:", "  port: 70000"].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("port");
  });

  test("rejects non-boolean enableVectorSearch", async () => {
    const p = writeManifest(
      [
        "model:",
        "  name: google/gemini-2.0-flash-001",
        "nexus:",
        '  enableVectorSearch: "yes"',
      ].join("\n"),
    );
    const result = await loadManifestConfig(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("enableVectorSearch");
  });
});
