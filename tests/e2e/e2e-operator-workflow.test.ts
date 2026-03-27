/**
 * E2E smoke test for the core operator workflow.
 *
 * Validates the primary user journey: init -> status -> doctor -> stop.
 * Does NOT require ANTHROPIC_API_KEY — these test the CLI machinery, not the LLM.
 *
 * Run (from repo root):
 *   bun test tests/e2e/e2e-operator-workflow.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLI_BIN = join(REPO_ROOT, "packages/meta/cli/src/bin.ts");
const BUN = process.execPath;
const TIMEOUT_MS = 30_000;
const AGENT_NAME = "e2e-smoke-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Runs the koi CLI as a subprocess. Returns stdout, stderr, and exit code.
 * Uses Bun.spawn with a timeout to prevent hanging tests.
 */
async function runCli(
  args: readonly string[],
  options?: { readonly cwd?: string; readonly timeout?: number },
): Promise<SpawnResult> {
  const timeout = options?.timeout ?? TIMEOUT_MS;

  const proc = Bun.spawn([BUN, CLI_BIN, ...args], {
    cwd: options?.cwd ?? REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Prevent interactive prompts from hanging
      CI: "1",
      // Suppress color codes in output
      NO_COLOR: "1",
    },
  });

  // Collect stdout and stderr as text
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  // Race against a timeout to prevent hanging
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(
        new Error(
          `CLI command timed out after ${String(timeout)}ms: ${BUN} ${CLI_BIN} ${args.join(" ")}`,
        ),
      );
    }, timeout);
  });

  const [stdout, stderr, exitCode] = await Promise.race([
    Promise.all([stdoutPromise, stderrPromise, proc.exited]),
    timeoutPromise.then((): never => {
      throw new Error("unreachable");
    }),
  ]);

  return { stdout, stderr, exitCode };
}

/**
 * Parses a JSON string, returning undefined on failure.
 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("operator workflow", () => {
  // Shared temp directory for the entire suite — sequential tests build on each other
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-e2e-operator-"));
  });

  afterAll(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (error: unknown) {
      console.warn("Failed to remove temp dir", tempDir, error);
    }
  });

  // ── Test 1: koi init creates a valid project scaffold ──────────────

  it(
    "koi init creates a valid project scaffold",
    async () => {
      const initDir = join(tempDir, "agent");

      const result = await runCli([
        "init",
        initDir,
        "--yes",
        "--name",
        AGENT_NAME,
        "--template",
        "minimal",
      ]);

      // init may print warnings to stderr (e.g. nexus CLI not found) — that is OK
      // It should not hard-fail (exit code 0 or 1 for non-critical warnings)
      expect(result.exitCode).toBe(0);

      // koi.yaml must exist in the target directory
      const manifestPath = join(initDir, "koi.yaml");
      expect(existsSync(manifestPath)).toBe(true);

      // koi.yaml must be valid YAML containing the agent name
      const yamlContent = await readFile(manifestPath, "utf-8");
      expect(yamlContent).toContain(`name: ${AGENT_NAME}`);

      // package.json must exist
      expect(existsSync(join(initDir, "package.json"))).toBe(true);

      // .env must exist (created by minimal template)
      expect(existsSync(join(initDir, ".env"))).toBe(true);
    },
    TIMEOUT_MS,
  );

  // ── Test 2: koi status reports agent state in JSON ─────────────────

  it(
    "koi status --json reports agent state",
    async () => {
      const initDir = join(tempDir, "agent");
      const manifestPath = join(initDir, "koi.yaml");

      // status --json returns structured output. The agent is not running,
      // so the health probe will fail, but the command itself should succeed
      // in producing valid JSON output.
      const result = await runCli(["status", "--json", "--manifest", manifestPath], {
        cwd: initDir,
      });

      // status exits non-zero when agent is not running — that is expected
      // The important thing is that stdout contains valid JSON
      const parsed = tryParseJson(result.stdout);
      expect(parsed).toBeDefined();

      // Verify expected JSON structure
      const status = parsed as Record<string, unknown>;
      expect(status.agent).toBe(AGENT_NAME);
      expect(status).toHaveProperty("service");
      expect(status).toHaveProperty("health");
      expect(status).toHaveProperty("admin");
      expect(status).toHaveProperty("nexus");

      // Service object should contain platform and status fields
      const service = status.service as Record<string, unknown>;
      expect(typeof service.platform).toBe("string");
      expect(typeof service.status).toBe("string");
    },
    TIMEOUT_MS,
  );

  // ── Test 3: koi status --json exit code reflects health ────────────

  it(
    "koi status --json exit code reflects subsystem health",
    async () => {
      const initDir = join(tempDir, "agent");
      const manifestPath = join(initDir, "koi.yaml");

      const result = await runCli(["status", "--json", "--manifest", manifestPath], {
        cwd: initDir,
      });

      // Exit code 0 only when health endpoint responds 200.
      // In this test no agent is running, so health endpoint is unreachable → exit 1.
      expect(result.exitCode).toBe(1);

      // Verify the output is valid JSON regardless of exit code
      const parsed = tryParseJson(result.stdout);
      expect(parsed).toBeDefined();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: koi doctor reports diagnostics in JSON ─────────────────

  it(
    "koi doctor --json reports diagnostics with checks and summary",
    async () => {
      const initDir = join(tempDir, "agent");
      const manifestPath = join(initDir, "koi.yaml");

      const result = await runCli(["doctor", "--json", "--manifest", manifestPath], {
        cwd: initDir,
      });

      // doctor may exit non-zero when checks fail (no running service) — expected
      const parsed = tryParseJson(result.stdout);
      expect(parsed).toBeDefined();

      const doctor = parsed as Record<string, unknown>;

      // Must have checks array
      expect(Array.isArray(doctor.checks)).toBe(true);
      const checks = doctor.checks as readonly Record<string, unknown>[];
      expect(checks.length).toBeGreaterThan(0);

      // Each check should have id, name, status, message
      const firstCheck = checks[0];
      expect(firstCheck).toBeDefined();
      if (firstCheck !== undefined) {
        expect(typeof firstCheck.id).toBe("string");
        expect(typeof firstCheck.name).toBe("string");
        expect(typeof firstCheck.status).toBe("string");
        expect(typeof firstCheck.message).toBe("string");
      }

      // Must have summary object with pass/warn/fail counts
      expect(doctor).toHaveProperty("summary");
      const summary = doctor.summary as Record<string, unknown>;
      expect(typeof summary.pass).toBe("number");
      expect(typeof summary.warn).toBe("number");
      expect(typeof summary.fail).toBe("number");
    },
    TIMEOUT_MS,
  );

  // ── Test 5: koi stop handles non-running service gracefully ────────

  it(
    "koi stop handles non-running service gracefully",
    async () => {
      const initDir = join(tempDir, "agent");
      const manifestPath = join(initDir, "koi.yaml");

      const result = await runCli(["stop", "--manifest", manifestPath], { cwd: initDir });

      // stop should report that the service is not installed / not running
      // and exit without crashing. The stderr should contain a meaningful message.
      const combined = result.stdout + result.stderr;
      const indicatesNotRunning =
        combined.includes("not installed") ||
        combined.includes("not-installed") ||
        combined.includes("already stopped") ||
        combined.includes("already inactive") ||
        combined.includes("not running");

      expect(indicatesNotRunning).toBe(true);
    },
    TIMEOUT_MS,
  );
});
