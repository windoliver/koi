import type {
  KoiError,
  Result,
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxExecOptions,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";

import { detectPlatform, type PlatformInfo, type SandboxPlatform } from "./detect.js";
import { buildBwrapPrefix, buildBwrapSuffix } from "./platform/bwrap.js";
import { buildSeatbeltPrefix, generateSeatbeltProfile } from "./platform/seatbelt.js";
import { validateProfile } from "./validate.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MB — matches @koi/middleware-sandbox default

/** `SandboxAdapter` (L0) extended with OS-level platform metadata. */
export interface SandboxOsAdapter extends SandboxAdapter {
  readonly platform: PlatformInfo;
}

function validationError(message: string): Result<never, KoiError> {
  return { ok: false, error: { code: "VALIDATION", message, retryable: false } };
}

function missingBinaryReason(platform: SandboxPlatform): string {
  return platform === "seatbelt"
    ? "Binary 'sandbox-exec' not found in PATH"
    : "Binary 'bwrap' not found in PATH";
}

/** Shared mutable byte budget across stdout + stderr to enforce a combined cap. */
interface ByteBudget {
  remaining: number;
}

/**
 * Stream a ReadableStream into a string, drawing from a shared ByteBudget.
 * Truncates when the shared budget is exhausted, enforcing a combined cap.
 * Calls onChunk for each decoded text chunk before truncation.
 */
async function collectStream(
  stream: ReadableStream<Uint8Array>,
  budget: ByteBudget,
  onChunk?: (chunk: string) => void,
): Promise<{ text: string; truncated: boolean }> {
  // One decoder per stream — shared TextDecoder state corrupts multi-byte sequences
  // when stdout and stderr are decoded concurrently.
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (budget.remaining <= 0) {
        // Budget exhausted — mark truncated but keep draining to prevent pipe-full deadlock.
        // A child blocked on write() will never exit if we stop reading.
        truncated = true;
        continue;
      }
      const chunk = value.length <= budget.remaining ? value : value.slice(0, budget.remaining);
      const chunkText = decoder.decode(chunk, { stream: true });
      text += chunkText;
      budget.remaining -= chunk.length;
      onChunk?.(chunkText);
      if (value.length > chunk.length) {
        // This chunk exhausted the budget; mark truncated and keep draining.
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text, truncated };
}

/**
 * Build an effective AbortSignal combining an optional caller signal with
 * an optional per-exec timeout. Returns [signal, cleanup] — always call cleanup().
 * Sets timedOutRef.value = true when the internal timeout fires.
 */
function buildExecSignal(
  opts: SandboxExecOptions | undefined,
  timedOutRef: { value: boolean },
): [AbortSignal | undefined, () => void] {
  const signals: AbortSignal[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (opts?.signal !== undefined) signals.push(opts.signal);

  if (opts?.timeoutMs !== undefined) {
    const controller = new AbortController();
    timer = setTimeout(() => {
      timedOutRef.value = true;
      controller.abort();
    }, opts.timeoutMs);
    signals.push(controller.signal);
  }

  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer);
  };

  if (signals.length === 0) return [undefined, cleanup];
  if (signals.length === 1) return [signals[0], cleanup];
  return [AbortSignal.any(signals), cleanup];
}

/**
 * Create a SandboxInstance backed by the given platform and pre-validated profile.
 * Conforms to the L0 SandboxInstance contract: exec() returns Promise<SandboxAdapterResult>.
 */
function createInstance(platform: SandboxPlatform, profile: SandboxProfile): SandboxInstance {
  // Pre-compute profile-constant prefix once at create() time
  const commandPrefix =
    platform === "seatbelt"
      ? buildSeatbeltPrefix(generateSeatbeltProfile(profile))
      : buildBwrapPrefix(profile);

  return {
    async exec(
      command: string,
      args: readonly string[],
      opts?: SandboxExecOptions,
    ): Promise<SandboxAdapterResult> {
      const argv =
        platform === "seatbelt"
          ? [...commandPrefix, command, ...args]
          : [...commandPrefix, ...buildBwrapSuffix(profile, command, args)];

      const maxBytes = opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const start = Date.now();
      const timedOutRef = { value: false };
      // Profile-level timeout as fallback; per-call opts.timeoutMs takes precedence.
      const resolvedTimeoutMs = opts?.timeoutMs ?? profile.resources.timeoutMs;
      const effectiveOpts =
        resolvedTimeoutMs !== undefined ? { ...opts, timeoutMs: resolvedTimeoutMs } : opts;
      const [effectiveSignal, cleanupSignal] = buildExecSignal(effectiveOpts, timedOutRef);

      const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
        stdout: "pipe",
        stderr: "pipe",
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts?.env !== undefined ? { env: opts.env } : {}),
        ...(opts?.stdin !== undefined ? { stdin: new TextEncoder().encode(opts.stdin) } : {}),
      };

      const proc = Bun.spawn(argv, spawnOpts);

      // Check immediately after spawn — signal may have been aborted before or during spawn.
      if (effectiveSignal?.aborted === true) {
        proc.kill();
      }

      const abortHandler = (): void => {
        proc.kill();
      };
      effectiveSignal?.addEventListener("abort", abortHandler, { once: true });

      // Narrow stream types — guaranteed by stdout/stderr: "pipe"
      const stdoutStream = proc.stdout;
      const stderrStream = proc.stderr;
      if (!(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
        throw new Error("Bun.spawn must return ReadableStream when stdout/stderr is 'pipe'");
      }

      const budget: ByteBudget = { remaining: maxBytes };
      const [stdoutResult, stderrResult, exitCode] = await Promise.all([
        collectStream(stdoutStream, budget, opts?.onStdout),
        collectStream(stderrStream, budget, opts?.onStderr),
        proc.exited,
      ]);

      effectiveSignal?.removeEventListener("abort", abortHandler);
      cleanupSignal();

      const truncated = stdoutResult.truncated || stderrResult.truncated;
      return {
        exitCode,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        durationMs: Date.now() - start,
        timedOut: timedOutRef.value,
        oomKilled: false,
        ...(truncated ? { truncated } : {}),
        ...(proc.signalCode != null ? { signal: String(proc.signalCode) } : {}),
      };
    },
    async readFile(_path: string): Promise<Uint8Array> {
      throw new Error("readFile not implemented — use @koi/nexus-fuse-mount for virtual FS");
    },
    async writeFile(_path: string, _data: Uint8Array): Promise<void> {
      throw new Error("writeFile not implemented — use @koi/nexus-fuse-mount for virtual FS");
    },
    async destroy(): Promise<void> {},
  };
}

export function createOsAdapter(): Result<SandboxOsAdapter, KoiError> {
  const detected = detectPlatform();
  if (!detected.ok) return detected;

  const available = Bun.which(detected.value === "seatbelt" ? "sandbox-exec" : "bwrap");
  if (available === null) {
    return validationError(missingBinaryReason(detected.value));
  }

  return {
    ok: true,
    value: createOsAdapterForTest({ platform: detected.value, available: true }),
  };
}

export function createOsAdapterForTest(opts: {
  readonly platform: SandboxPlatform;
  readonly available: boolean;
}): SandboxOsAdapter {
  return {
    name: "@koi/sandbox-os",
    platform: {
      platform: opts.platform,
      available: opts.available,
      ...(opts.available ? {} : { reason: missingBinaryReason(opts.platform) }),
    },
    async create(profile: SandboxProfile): Promise<SandboxInstance> {
      const validated = validateProfile(profile, opts.platform);
      if (!validated.ok) {
        throw new Error(validated.error.message, { cause: validated.error });
      }
      return createInstance(opts.platform, validated.value);
    },
  };
}
