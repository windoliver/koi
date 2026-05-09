/**
 * Race-test orchestrator. Spawns two child processes that each call into the
 * docker adapter against the SAME KOI_SANDBOX_DOCKER_STATE_DIR. After both
 * complete, asserts the cross-process invariants hold.
 *
 * Usage:
 *   bun run scratch/race-runner.ts <scenario>
 *
 * Scenarios:
 *   findOrCreate      Two findOrCreate(scope) — expect ONE container survives.
 *   destroy-vs-create Process A destroyScope, process B findOrCreate same scope.
 *   squatter          Foreign container holds the label; findOrCreate must fail closed.
 *   profile-drift     findOrCreate; mutate profile; findOrCreate again — expect drift error.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCENARIO = process.argv[2];
const IMAGE = "alpine:3.20";

if (SCENARIO === undefined) {
  console.error("Usage: bun run scratch/race-runner.ts <scenario>");
  process.exit(2);
}

async function dockerAvailable(): Promise<boolean> {
  const p = Bun.spawn(["docker", "version", "--format", "ok"], { stdout: "pipe", stderr: "pipe" });
  return (await p.exited) === 0;
}

async function listScope(scope: string): Promise<readonly string[]> {
  const p = Bun.spawn(
    ["docker", "ps", "-aq", "--no-trunc", "--filter", `label=koi.sandbox.scope=${scope}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  await p.exited;
  return (await new Response(p.stdout).text())
    .trim()
    .split("\n")
    .filter((x) => x);
}

async function rmAllScope(scope: string): Promise<void> {
  const ids = await listScope(scope);
  if (ids.length === 0) return;
  const p = Bun.spawn(["docker", "rm", "-f", ...ids], { stdout: "pipe", stderr: "pipe" });
  await p.exited;
}

async function spawnWorker(
  stateDir: string,
  scope: string,
  action: string,
  delayMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; tag: string }> {
  const tag = `${action}/${scope}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const proc = Bun.spawn(
    ["bun", "run", `${import.meta.dir}/race-worker.ts`, action, scope, String(delayMs)],
    {
      env: { ...process.env, KOI_SANDBOX_DOCKER_STATE_DIR: stateDir, KOI_RACE_TAG: tag },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr, tag };
}

function header(name: string): void {
  console.log(`\n══════ scenario: ${name} ══════`);
}

function pass(msg: string): void {
  console.log(`✓ ${msg}`);
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!(await dockerAvailable())) {
    console.error("docker not available");
    process.exit(2);
  }

  const stateDir = mkdtempSync(join(tmpdir(), "koi-race-state-"));
  const scope = `race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    if (SCENARIO === "findOrCreate") {
      header("two parallel findOrCreate same scope");
      const [a, b] = await Promise.all([
        spawnWorker(stateDir, scope, "findOrCreate", 0),
        spawnWorker(stateDir, scope, "findOrCreate", 0),
      ]);
      console.log(`worker A exit=${a.exitCode}\n${a.stdout}${a.stderr}`);
      console.log(`worker B exit=${b.exitCode}\n${b.stdout}${b.stderr}`);
      const ids = await listScope(scope);
      if (ids.length !== 1) {
        fail(`expected exactly 1 container, found ${ids.length}: ${ids.join(",")}`);
      }
      pass(`exactly 1 container survives both racers (${ids[0]})`);
      if (a.exitCode !== 0 || b.exitCode !== 0) {
        fail("at least one worker did not succeed");
      }
      pass("both workers succeeded (loser correctly attached to winner)");
    } else if (SCENARIO === "destroy-vs-create") {
      header("destroyScope racing findOrCreate same scope");
      // Pre-create so destroy has something to remove.
      const seed = await spawnWorker(stateDir, scope, "findOrCreate", 0);
      if (seed.exitCode !== 0) fail(`seed worker failed: ${seed.stderr}`);
      pass("seed container created");

      const [destroyer, creator] = await Promise.all([
        spawnWorker(stateDir, scope, "destroyScope", 0),
        // Slight delay so destroy starts first; creator should observe a
        // clean slate or the new owned slot.
        spawnWorker(stateDir, scope, "findOrCreate", 50),
      ]);
      console.log(`destroyer exit=${destroyer.exitCode}\n${destroyer.stdout}${destroyer.stderr}`);
      console.log(`creator   exit=${creator.exitCode}\n${creator.stdout}${creator.stderr}`);
      const ids = await listScope(scope);
      // Creator should have produced exactly one live container; destroy may
      // have raced and either removed seed or seen creator's replacement.
      // Invariant: exactly one container owned at the end + creator succeeded.
      if (creator.exitCode !== 0) fail("creator must succeed");
      if (ids.length !== 1) {
        fail(`expected exactly 1 container at end, got ${ids.length}: ${ids.join(",")}`);
      }
      pass(`exactly 1 container at end (${ids[0]})`);
    } else if (SCENARIO === "squatter") {
      header("foreign label squatter blocks findOrCreate");
      // Seed a container with the scope label using docker directly — no
      // koi state, no registry entry. findOrCreate must refuse.
      const seedProc = Bun.spawn(
        ["docker", "run", "-d", "--label", `koi.sandbox.scope=${scope}`, IMAGE, "sleep", "60"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const seedId = (await new Response(seedProc.stdout).text()).trim();
      const seedExit = await seedProc.exited;
      if (seedExit !== 0) fail("could not seed squatter");
      pass(`squatter container seeded (${seedId.slice(0, 12)})`);

      const w = await spawnWorker(stateDir, scope, "findOrCreate", 0);
      console.log(`worker exit=${w.exitCode}\n${w.stdout}${w.stderr}`);
      if (w.exitCode === 0) fail("findOrCreate must reject — got success");
      if (!w.stderr.includes("we do not own")) {
        fail(`expected 'we do not own' in stderr, got: ${w.stderr.slice(0, 300)}`);
      }
      pass("findOrCreate failed closed with 'we do not own'");

      const ids = await listScope(scope);
      if (ids.length !== 1 || ids[0] !== seedId) {
        fail(`squatter should be the only container, got: ${ids.join(",")}`);
      }
      pass("squatter intact, no duplicate created");
    } else if (SCENARIO === "profile-drift") {
      header("profile drift on second findOrCreate");
      const a = await spawnWorker(stateDir, scope, "findOrCreate", 0);
      if (a.exitCode !== 0) fail(`first findOrCreate failed: ${a.stderr}`);
      pass("first findOrCreate succeeded");
      const b = await spawnWorker(stateDir, scope, "findOrCreate-network", 0);
      if (b.exitCode === 0) fail("drifted findOrCreate must reject");
      if (!b.stderr.includes("different profile")) {
        fail(`expected 'different profile' in stderr, got: ${b.stderr.slice(0, 300)}`);
      }
      pass("drifted findOrCreate failed closed with 'different profile'");
    } else {
      console.error(`unknown scenario: ${SCENARIO}`);
      process.exit(2);
    }

    console.log(`\n══════ ${SCENARIO} PASSED ══════\n`);
  } finally {
    await rmAllScope(scope).catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
}

await main();
