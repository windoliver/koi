import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifestConfig, revalidateAuditPathContainment } from "./manifest.js";

// Regression tests for #1777 — manifest.filesystem must be parsed,
// validated, and surfaced so `koi start --manifest` / `koi tui --manifest`
// can wire alternate filesystem backends instead of silently falling
// through to the default local backend.

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

  test("accepts unknown keys in lenient mode but surfaces them as presence sentinels", async () => {
    // A typo'd key (sqltie instead of sqlite) must not block startup, but it
    // signals attempted audit configuration. The gate-off fail-closed check in
    // tui-command.ts uses presence sentinels ("") to refuse startup unless the
    // operator provides KOI_AUDIT_* overrides.
    const p = writeManifest(
      ["model:", "  name: google/gemini-2.0-flash-001", "audit:", "  sqltie: ./logs/audit.db"].join(
        "\n",
      ),
    );
    const result = await loadManifestConfig(p, { skipAuditValidation: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.audit?.present).toBe(true);
    // Unknown key → all three known fields get "" sentinel (not undefined) so
    // the gate-off check fires for any of the three override env vars.
    expect(result.value.audit?.ndjson).toBe("");
    expect(result.value.audit?.sqlite).toBe("");
    expect(result.value.audit?.violations).toBe("");
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
    const p = writeManifest(
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
