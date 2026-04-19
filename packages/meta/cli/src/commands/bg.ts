/**
 * `koi bg` — operate on background-agent sessions tracked in the daemon
 * session registry.
 *
 * Subcommands: ps | logs | kill | attach | detach.
 *
 * All reads (ps/logs/attach) go straight to the on-disk registry; they do
 * not require a running supervisor. `kill` signals the PID directly and
 * then updates the registry — it also works without the originating
 * supervisor being alive (useful for cleaning up sessions whose parent
 * crashed without graceful shutdown).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { BackgroundSessionRecord, WorkerId } from "@koi/core";
import { workerId } from "@koi/core";
import { createFileSessionRegistry } from "@koi/daemon";
import type { CliFlags } from "../args.js";
import { isBgFlags } from "../args.js";
import { ExitCode } from "../types.js";

// ---------------------------------------------------------------------------
// Command entry
// ---------------------------------------------------------------------------

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isBgFlags(flags)) return ExitCode.FAILURE;
  if (flags.subcommand === undefined) return ExitCode.FAILURE;

  const dir = flags.registryDir ?? defaultRegistryDir();
  const registry = createFileSessionRegistry({ dir });

  switch (flags.subcommand) {
    case "ps":
      return runPs(registry, flags.json);
    case "logs":
      return runLogs(registry, flags.workerId, flags.follow);
    case "kill":
      return runKill(registry, flags.workerId);
    case "attach":
      return runAttach(registry, flags.workerId);
    case "detach":
      return runDetach();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the default registry directory. Honors `KOI_STATE_DIR` when set,
 * otherwise falls back to `~/.koi/daemon/sessions`. Keeps the CLI usable
 * without any environment configuration.
 */
export function defaultRegistryDir(): string {
  const stateDir = process.env.KOI_STATE_DIR;
  if (stateDir !== undefined && stateDir.length > 0) {
    return join(stateDir, "daemon", "sessions");
  }
  return join(homedir(), ".koi", "daemon", "sessions");
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// ---------------------------------------------------------------------------
// `ps` — list sessions
// ---------------------------------------------------------------------------

async function runPs(
  registry: ReturnType<typeof createFileSessionRegistry>,
  json: boolean,
): Promise<ExitCode> {
  // Use describeList() so filesystem faults (EACCES, broken mount) surface
  // as an explicit failure rather than silently printing "No background
  // sessions" — the latter would mislead operators during incidents.
  const res = await registry.describeList();
  if (!res.ok) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: res.error })}\n`);
    } else {
      process.stderr.write(`Registry unavailable (${res.error.code}): ${res.error.message}\n`);
    }
    return ExitCode.FAILURE;
  }
  const records = res.value;
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: records })}\n`);
    return ExitCode.OK;
  }

  if (records.length === 0) {
    process.stdout.write("No background sessions.\n");
    return ExitCode.OK;
  }

  // Newest-first for operator scanning.
  const sorted = [...records].sort((a, b) => b.startedAt - a.startedAt);
  const now = Date.now();
  const idWidth = Math.max(8, ...sorted.map((r) => r.workerId.length));
  const agentWidth = Math.max(5, ...sorted.map((r) => r.agentId.length));
  const statusWidth = 8;

  process.stdout.write(
    `  ${"WORKER".padEnd(idWidth)}  ${"AGENT".padEnd(agentWidth)}  ${"STATUS".padEnd(statusWidth)}  ${"PID".padStart(6)}  ${"UPTIME".padStart(7)}\n`,
  );
  process.stdout.write(
    `  ${"─".repeat(idWidth)}  ${"─".repeat(agentWidth)}  ${"─".repeat(statusWidth)}  ${"─".repeat(6)}  ${"─".repeat(7)}\n`,
  );

  for (const r of sorted) {
    const endedAt = r.endedAt ?? now;
    const uptime = formatDuration(endedAt - r.startedAt);
    process.stdout.write(
      `  ${r.workerId.padEnd(idWidth)}  ${r.agentId.padEnd(agentWidth)}  ${r.status.padEnd(statusWidth)}  ${String(r.pid).padStart(6)}  ${uptime.padStart(7)}\n`,
    );
  }
  return ExitCode.OK;
}

// ---------------------------------------------------------------------------
// `logs` — tail a session's log file
// ---------------------------------------------------------------------------

/**
 * Look up a record by id, writing a diagnostic to stderr and returning
 * undefined if the id cannot be resolved. Uses the registry's detailed
 * `describe()` so operators see a specific error ("validation error",
 * "registry read failed") instead of a misleading "No such session"
 * when the underlying cause is a permission issue or a corrupt record.
 */
async function lookup(
  registry: ReturnType<typeof createFileSessionRegistry>,
  id: string,
): Promise<BackgroundSessionRecord | undefined> {
  const desc = await registry.describe(workerId(id));
  if (!desc.ok) {
    process.stderr.write(
      `Session ${id}: registry read failed (${desc.error.code}): ${desc.error.message}\n`,
    );
    return undefined;
  }
  if (desc.value === undefined) {
    process.stderr.write(`No such session: ${id}\n`);
    return undefined;
  }
  return desc.value;
}

async function runLogs(
  registry: ReturnType<typeof createFileSessionRegistry>,
  id: string | undefined,
  follow: boolean,
): Promise<ExitCode> {
  if (id === undefined) return ExitCode.FAILURE;
  const record = await lookup(registry, id);
  if (record === undefined) return ExitCode.FAILURE;
  if (record.logPath === "") {
    process.stderr.write(`Session ${id} has no log capture.\n`);
    return ExitCode.FAILURE;
  }

  const file = Bun.file(record.logPath);
  if (!(await file.exists())) {
    process.stderr.write(`Log file missing: ${record.logPath}\n`);
    return ExitCode.FAILURE;
  }

  // Print the existing content, then optionally continue tailing.
  // Track offsets in BYTES (not code units) — `Bun.file().size` and
  // `.slice(start, end)` are byte-addressed, and mixing them with the
  // character length of `string.length` would skip or duplicate bytes
  // whenever the log contains multi-byte UTF-8 runs. Take the byte
  // snapshot before reading content so a concurrent write that lands
  // between the read and the size capture doesn't cause us to re-emit
  // its bytes in the first tail iteration.
  let lastSize = file.size;
  const existing = await file.text();
  process.stdout.write(existing);

  if (!follow) return ExitCode.OK;

  // Poll every 200ms — low overhead, fast enough for interactive log viewing.
  // Terminate only when the session is no longer running: this avoids
  // infinite tails for exited workers whose logs never grow again.
  while (true) {
    await Bun.sleep(200);
    const current = await registry.get(workerId(id));
    const live = current?.status === "running" || current?.status === "detached";
    const fresh = Bun.file(record.logPath);
    const newSize = fresh.size;
    if (newSize > lastSize) {
      const slice = await fresh.slice(lastSize, newSize).text();
      process.stdout.write(slice);
      lastSize = newSize;
    }
    if (!live) return ExitCode.OK;
  }
}

// ---------------------------------------------------------------------------
// `kill` — terminate a session's PID and update registry
// ---------------------------------------------------------------------------

async function runKill(
  registry: ReturnType<typeof createFileSessionRegistry>,
  id: string | undefined,
): Promise<ExitCode> {
  if (id === undefined) return ExitCode.FAILURE;
  const record = await lookup(registry, id);
  if (record === undefined) return ExitCode.FAILURE;
  if (record.status === "exited" || record.status === "crashed") {
    process.stderr.write(`Session ${id} is already ${record.status}.\n`);
    return ExitCode.OK;
  }
  if (record.pid <= 0) {
    process.stderr.write(`Session ${id} has no PID (backend=${record.backendKind}).\n`);
    return ExitCode.FAILURE;
  }

  // Pre-signal identity claim: CAS-update the record under the registry
  // lockfile before sending any signal. A resumed kill (status already
  // "terminating") still takes this path so we re-verify the pid+version
  // against the live record and bump the version — skipping a fresh
  // claim would let a second kill run against a stranded record without
  // re-proving that the stored pid hasn't been reused by the OS.
  //
  // Even with this guard there is a residual PID-reuse risk: between
  // the claim and the signal, the OS could technically reuse a PID the
  // same user owns. Fully closing that window requires a platform-
  // specific process-birth fingerprint (Linux `/proc/<pid>/stat` start
  // time, macOS `ps -o lstart`) which is deferred to 3b-5 when richer
  // process metadata is plumbed through the backend contract. Here we
  // rely on (a) the lockfile-serialized claim to prove registry state
  // is current, and (b) post-signal identity re-verification before
  // any SIGKILL escalation.
  // Claim identity WITHOUT stamping `signaledAt`. Operator-intent
  // freshness is deferred to the post-SIGTERM stamp below — stamping
  // here would let any pre-signal failure (fingerprint drift, `ps`
  // unavailable, caller crash) leave a fresh "intent" marker on a
  // record where no signal was ever sent. The bridge would then
  // downgrade a later genuine crash to `exited` within the 30s
  // window, silently masking real faults.
  const claim = await registry.update(workerId(id), {
    status: "terminating",
    expectedVersion: record.version ?? 0,
    expectedPid: record.pid,
  });
  if (!claim.ok) {
    if (claim.error.code === "CONFLICT") {
      process.stderr.write(
        `Session ${id}: identity drifted before signal; refusing to kill (${claim.error.message}).\n`,
      );
      return ExitCode.FAILURE;
    }
    process.stderr.write(
      `Session ${id}: failed to claim termination (${claim.error.code}): ${claim.error.message}\n`,
    );
    return ExitCode.FAILURE;
  }
  const claimedVersion = claim.value.version ?? 0;
  if (record.status === "terminating") {
    process.stdout.write(
      `Session ${id}: resumed stranded termination (previous kill did not finalize); re-verified identity.\n`,
    );
  }

  // Capture a pre-signal process birth fingerprint. This is our only
  // proof that the PID we're about to signal belongs to the process
  // we intended (the registry's pid field is cheap to keep current,
  // but between our read and the signal the kernel could have
  // recycled it). Everything we do later (SIGTERM, wait loop, SIGKILL)
  // must match this fingerprint.
  //
  // Fail-closed policy with a pragmatic carve-out: when the
  // fingerprint is unobtainable AND `isProcessAlive(pid)` reports no
  // live process, the worker is definitively gone. In that case we
  // finalize the registry record to `exited` immediately instead of
  // stranding it as `terminating`. We only refuse to proceed when
  // the process appears alive but we cannot prove its identity —
  // that's the ambiguous case where blindly signaling is dangerous.
  const preSignalFingerprint = await processBirthFingerprint(record.pid);
  if (preSignalFingerprint === undefined) {
    if (!isProcessAlive(record.pid)) {
      const finalize = await registry.update(workerId(id), {
        status: "exited",
        endedAt: Date.now(),
        expectedVersion: claimedVersion,
        expectedPid: record.pid,
      });
      if (finalize.ok) {
        process.stdout.write(
          `Session ${id} (pid ${record.pid}) already gone; finalized as exited.\n`,
        );
        return ExitCode.OK;
      }
      // Bridge may have already written a terminal state — preserve it.
      const postFinal = await registry.get(workerId(id));
      if (postFinal?.status === "exited" || postFinal?.status === "crashed") {
        process.stdout.write(
          `Session ${id}: bridge recorded ${postFinal.status}; leaving registry intact.\n`,
        );
        return ExitCode.OK;
      }
      process.stderr.write(
        `Session ${id}: pid ${record.pid} gone but registry finalize failed (${finalize.error.code}): ${finalize.error.message}\n`,
      );
      return ExitCode.FAILURE;
    }
    process.stderr.write(
      `Session ${id}: cannot read pid ${record.pid} birth-time via ps while process appears alive; refusing to signal.\n`,
    );
    return ExitCode.FAILURE;
  }

  // Re-verify the fingerprint immediately before sending SIGTERM. This
  // narrows the TOCTOU window to a single ps invocation plus one signal
  // syscall — not zero (full closure requires platform-specific
  // primitives like Linux pidfd_signal), but enough to catch the common
  // case of a PID that exited and got recycled since our initial read.
  const atSignalFingerprint = await processBirthFingerprint(record.pid);
  if (atSignalFingerprint !== preSignalFingerprint) {
    process.stderr.write(
      `Session ${id}: pid ${record.pid} birth-time changed between claim and SIGTERM ` +
        `(${JSON.stringify(preSignalFingerprint)} → ${JSON.stringify(atSignalFingerprint)}); refusing to signal.\n`,
    );
    return ExitCode.FAILURE;
  }

  const signaled = sendSignal(record.pid, "SIGTERM");
  if (signaled.kind === "error") {
    process.stderr.write(`Failed to signal pid ${record.pid}: ${signaled.error}\n`);
    // We set `terminating` but never signaled — best-effort revert so the
    // record doesn't strand. If the revert races the bridge it'll fail
    // with CONFLICT, which is fine: either way the record is no longer a
    // zombie "terminating" entry. On any later failure path we rely on
    // the resume-on-same-identity logic above instead of rolling back.
    if (record.status !== "terminating") {
      await registry.update(workerId(id), {
        status: "running",
        expectedVersion: claimedVersion,
        expectedPid: record.pid,
      });
    }
    return ExitCode.FAILURE;
  }

  // Stamp `signaledAt` ONLY when SIGTERM was actually delivered. The
  // `gone` case (ESRCH: process vanished between the fingerprint
  // re-check and this syscall) means no signal reached anyone — writing
  // an operator-intent marker anyway would let the bridge downgrade a
  // later genuine crash to `exited` within the freshness window, which
  // is exactly what this whole machinery is supposed to prevent.
  //
  // When `kind === "gone"` the worker is already dead; skip the stamp
  // and let the finalize CAS below either (a) observe the bridge's
  // classification (exited/crashed) and preserve it or (b) write
  // `exited` against the unchanged claim version. Either is correct for
  // a process that died on its own.
  let stampedVersion = claimedVersion;
  if (signaled.kind === "delivered") {
    // CAS conflict here is harmless — it means the bridge already wrote
    // a terminal state, which the finalize CAS below will correctly
    // preserve. There is a tiny window between SIGTERM and this stamp
    // where a near-instant crash could beat us and be recorded as
    // `crashed` instead of `exited`; that is the fail-safe direction
    // (reporting a kill as a crash is noisy but never silently masks a
    // real fault).
    const stamp = await registry.update(workerId(id), {
      signaledAt: Date.now(),
      expectedVersion: claimedVersion,
      expectedPid: record.pid,
    });
    if (stamp.ok) stampedVersion = stamp.value.version ?? 0;
  }

  // Give the process a short window to exit cleanly. If it doesn't respond
  // within the deadline, escalate to SIGKILL so operators never wait
  // indefinitely on a wedged worker.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(record.pid)) break;
    await Bun.sleep(100);
  }

  // PID-reuse fence + pre-escalation identity re-verification.
  //
  // After the SIGTERM deadline, re-read the registry. Three outcomes:
  //   1. Bridge moved the record to a terminal status (exited/crashed)
  //      — the worker is gone; preserve its classification and skip
  //      SIGKILL. The OS may already have reused the PID.
  //   2. Status is no longer our claim ("terminating") or pid drifted
  //      — someone else mutated the record. Refuse to escalate; we
  //      cannot prove `record.pid` still belongs to this session.
  //   3. Status is still "terminating" with the same pid — safe to
  //      escalate to SIGKILL if the process is still alive.
  let preservedTerminal = false;
  if (isProcessAlive(record.pid)) {
    const current = await registry.get(workerId(id));
    const terminated = current?.status === "exited" || current?.status === "crashed";
    if (terminated) {
      preservedTerminal = true;
      process.stdout.write(
        `Session ${id}: skipping SIGKILL and preserving registry status=${current?.status} (bridge already classified; PID ${record.pid} may be reused).\n`,
      );
    } else if (current?.status !== "terminating" || current.pid !== record.pid) {
      process.stderr.write(
        `Session ${id}: registry diverged from claim during SIGTERM window ` +
          `(status=${current?.status ?? "missing"}, pid=${current?.pid ?? "?"}); refusing to SIGKILL.\n`,
      );
      return ExitCode.FAILURE;
    } else {
      // Pre-escalation birth-time fingerprint check: fail CLOSED when
      // identity cannot be proven. `preSignalFingerprint` is guaranteed
      // defined by the SIGTERM-path guard above; a missing currentFingerprint
      // means the process is gone (in which case we wouldn't be here, since
      // the alive check passed), or `ps` stopped working mid-kill — refuse
      // to SIGKILL either way.
      const currentFingerprint = await processBirthFingerprint(record.pid);
      if (currentFingerprint === undefined) {
        process.stderr.write(
          `Session ${id}: cannot prove pid ${record.pid} identity via ps at escalation; refusing to SIGKILL.\n`,
        );
        return ExitCode.FAILURE;
      }
      if (currentFingerprint !== preSignalFingerprint) {
        process.stderr.write(
          `Session ${id}: pid ${record.pid} birth-time drifted since SIGTERM (${JSON.stringify(preSignalFingerprint)} → ${JSON.stringify(currentFingerprint)}); refusing to SIGKILL reused PID.\n`,
        );
        return ExitCode.FAILURE;
      }
      const killed = sendSignal(record.pid, "SIGKILL");
      if (killed.kind === "error") {
        process.stderr.write(`Failed to SIGKILL pid ${record.pid}: ${killed.error}\n`);
        return ExitCode.FAILURE;
      }
      // `delivered` and `gone` are both acceptable: the former means we
      // killed it; the latter means it died between our check and the
      // syscall. Fall through to the post-SIGKILL liveness verification.
      // After SIGKILL, confirm the process is actually gone before
      // claiming success — SIGKILL can be ignored (kernel protection,
      // zombie parent) and we must not report a false kill.
      await Bun.sleep(50);
      if (isProcessAlive(record.pid)) {
        process.stderr.write(
          `Session ${id}: pid ${record.pid} survived SIGKILL (uninterruptible state or wrong owner).\n`,
        );
        return ExitCode.FAILURE;
      }
    }
  }

  if (preservedTerminal) {
    // Already terminal — don't overwrite bridge's classification.
    return ExitCode.OK;
  }

  // Finalize: write terminal status conditioned on our most recent
  // successful CAS (`stampedVersion` — advanced past the `claimedVersion`
  // baseline by the post-SIGTERM `signaledAt` stamp when it committed).
  // If a concurrent bridge update slipped in and already marked the
  // worker exited/crashed, CAS fails and we preserve the bridge's
  // classification verbatim rather than rewriting it.
  const updated = await registry.update(workerId(id), {
    status: "exited",
    endedAt: Date.now(),
    expectedVersion: stampedVersion,
    expectedPid: record.pid,
  });
  let finalized = false;
  if (!updated.ok) {
    if (updated.error.code === "CONFLICT") {
      const postFinal = await registry.get(workerId(id));
      if (postFinal?.status === "exited" || postFinal?.status === "crashed") {
        process.stdout.write(
          `Session ${id}: bridge recorded ${postFinal.status} during shutdown; leaving registry intact.\n`,
        );
        finalized = true;
      } else {
        process.stderr.write(
          `Session ${id}: identity drifted during kill; refusing to overwrite (${updated.error.message}).\n`,
        );
        return ExitCode.FAILURE;
      }
    } else {
      process.stderr.write(
        `Session ${id}: terminated but registry update failed (${updated.error.code}): ${updated.error.message}\n`,
      );
      return ExitCode.FAILURE;
    }
  } else {
    process.stdout.write(`Session ${id} (pid ${record.pid}) terminated.\n`);
    finalized = true;
  }
  if (!finalized) return ExitCode.FAILURE;
  // Restart-policy warning (best-effort). Fires whenever we successfully
  // terminated the original process — both on the happy path (we wrote
  // exited) AND on the CAS-conflict branch (bridge beat us to a terminal
  // state). The CLI has no IPC to the supervisor and can't prevent
  // transient/permanent respawn, but it CAN detect the symptom and tell
  // the operator so they don't walk away thinking the session is dead.
  //
  // Poll structure: bounded loop with early exit on respawn detection.
  // The budget covers the default supervisor's exponential backoff
  // (`DEFAULT_WORKER_RESTART_POLICY.backoffBaseMs` = 1000ms) through
  // `restartAttempts = 2` (backoff = 1s, 2s, 4s — cumulative 7s), so
  // unstable workers that have already burned one or two restarts
  // still get a warning on the next respawn. Higher attempt counts
  // (3+ = 8s, 4+ = 16s, 5 = 30s under the default ceiling) are out
  // of scope: polling 30s on every kill would be user-hostile, and
  // the CLI has no way to read the supervisor's actual policy from
  // the registry. This is explicitly a best-effort diagnostic —
  // operators with deeply-flapping workers should cross-check with
  // `koi bg ps`, which the L3 doc now calls out.
  const RESPAWN_POLL_BUDGET_MS = 8_000;
  const RESPAWN_POLL_INTERVAL_MS = 250;
  const pollDeadline = Date.now() + RESPAWN_POLL_BUDGET_MS;
  while (Date.now() < pollDeadline) {
    await Bun.sleep(RESPAWN_POLL_INTERVAL_MS);
    const check = await registry.get(workerId(id));
    if (check === undefined) continue;
    if (check.pid !== record.pid && (check.status === "running" || check.status === "starting")) {
      process.stderr.write(
        `Note: session ${id} was respawned by the supervisor's restart policy ` +
          `(new pid ${check.pid}). \`koi bg kill\` signals a single process; ` +
          `to prevent respawn, configure the supervisor with a 'temporary' restart policy ` +
          `or stop the supervisor itself.\n`,
      );
      break;
    }
  }
  return ExitCode.OK;
}

// ---------------------------------------------------------------------------
// `attach` — follow logs (read-only for subprocess backend)
// ---------------------------------------------------------------------------

async function runAttach(
  registry: ReturnType<typeof createFileSessionRegistry>,
  id: string | undefined,
): Promise<ExitCode> {
  if (id === undefined) return ExitCode.FAILURE;
  const record = await lookup(registry, id);
  if (record === undefined) return ExitCode.FAILURE;
  if (record.backendKind === "subprocess") {
    process.stderr.write(
      "Interactive attach is not supported on the subprocess backend; " +
        "streaming logs read-only. Use the tmux backend for bi-directional attach.\n",
    );
    return runLogs(registry, id, true);
  }
  // Other backends (tmux/remote) implement true attach in follow-up
  // phases; for now we also fall back to log-following.
  process.stderr.write(
    `Attach for backend '${record.backendKind}' is not yet implemented; streaming logs.\n`,
  );
  return runLogs(registry, id, true);
}

// ---------------------------------------------------------------------------
// `detach` — placeholder (tmux backend owns this flow)
// ---------------------------------------------------------------------------

function runDetach(): Promise<ExitCode> {
  process.stderr.write(
    "koi bg detach is handled interactively by the attach client; the subprocess backend has no detachable session.\n",
  );
  return Promise.resolve(ExitCode.OK);
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

/**
 * Tri-state signal outcome. `delivered` means the signal was actually
 * handed to the kernel for the target pid; `gone` means the pid was
 * already dead (ESRCH) so no signal reached anyone; `error` is any other
 * failure. Downstream consumers must not conflate `delivered` with
 * `gone` — e.g. stamping operator-kill intent (`signaledAt`) on `gone`
 * would let the bridge misclassify a later genuine crash as an
 * operator-initiated exit.
 */
type SignalResult =
  | { readonly kind: "delivered" }
  | { readonly kind: "gone" }
  | { readonly kind: "error"; readonly error: string };

function sendSignal(pid: number, signal: "SIGTERM" | "SIGKILL"): SignalResult {
  try {
    process.kill(pid, signal);
    return { kind: "delivered" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ESRCH = process already gone. Surface this explicitly so callers
    // can distinguish "we killed it" from "it was already dead"; they
    // are semantically different for operator-intent tracking.
    if (msg.includes("ESRCH")) return { kind: "gone" };
    return { kind: "error", error: msg };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort process-birth fingerprint. Returns `ps -p <pid> -o lstart=`
 * output verbatim — exact format varies across platforms but is stable
 * for a given (PID, underlying process) pair. Used to detect PID reuse
 * between a CLI kill's initial lookup and any subsequent signal: if the
 * reported birth time changes, the kernel has rebound the PID to a
 * different process and we must refuse to signal.
 *
 * Returns `undefined` if `ps` fails or the pid is gone — callers should
 * treat that as "identity unknown" and refuse escalation (fail closed).
 */
async function processBirthFingerprint(pid: number): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "lstart="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return undefined;
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export type { BackgroundSessionRecord, WorkerId };
