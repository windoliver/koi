import type { IpcProcess } from "./types.js";

const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  6: "SIGABRT",
  9: "SIGKILL",
  11: "SIGSEGV",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
};

export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "LANG",
  "LC_ALL",
];

export function signalNameFromNumber(signal: number | undefined): string | undefined {
  if (signal === undefined) return undefined;
  return SIGNAL_NAMES[signal] ?? `SIG${signal}`;
}

function drainStream(stream: ReadableStream<Uint8Array> | null): void {
  if (stream === null) return;
  void stream
    .pipeTo(
      new WritableStream<Uint8Array>({
        write() {
          // Discard child stdio without buffering it in host memory.
        },
      }),
    )
    .catch(() => {});
}

let detectedSetsidPath: string | null | undefined;

function detectSetsid(): string | null {
  if (detectedSetsidPath !== undefined) return detectedSetsidPath;
  if (process.platform !== "linux" && process.platform !== "darwin") {
    detectedSetsidPath = null;
    return null;
  }
  try {
    detectedSetsidPath = Bun.which("setsid");
  } catch {
    detectedSetsidPath = null;
  }
  return detectedSetsidPath ?? null;
}

export function buildScrubbedEnv(allowlist: readonly string[]): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (typeof value === "string") {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

export function defaultSpawnFn(
  command: readonly string[],
  options: {
    readonly serialization: "advanced" | "json";
    readonly env?: Readonly<Record<string, string>>;
    readonly processGroupIsolation?: "required" | "best-effort";
  },
): IpcProcess {
  const messageHandlers: Array<(message: unknown) => void> = [];
  const setsidPath = detectSetsid();
  const isolationPolicy = options.processGroupIsolation ?? "required";
  if (setsidPath === null && isolationPolicy === "required") {
    throw new Error(
      "sandbox-ipc: process-group isolation is required but `setsid` is not available on this host. " +
        'Install `setsid` (util-linux) or set BridgeConfig.processGroupIsolation = "best-effort" to opt out.',
    );
  }
  const useGroup = setsidPath !== null;
  const spawnArgv: string[] = useGroup ? [setsidPath, "-w", ...command] : [...command];

  const proc = Bun.spawn(spawnArgv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    serialization: options.serialization,
    env: { ...(options.env ?? {}) },
    ipc(message: unknown) {
      for (const handler of messageHandlers) {
        handler(message);
      }
    },
  });

  drainStream(proc.stdout);
  drainStream(proc.stderr);

  function killGroup(signalName: NodeJS.Signals): void {
    if (useGroup) {
      try {
        // Negative pid signals the entire process group, terminating any descendants.
        process.kill(-proc.pid, signalName);
        return;
      } catch {
        // Fallthrough to direct kill if the group is already gone.
      }
    }
    proc.kill(signalName);
  }

  return {
    pid: proc.pid,
    exited: proc.exited,
    kill(signal?: number) {
      const signalName = (signalNameFromNumber(signal ?? 15) ?? "SIGTERM") as NodeJS.Signals;
      killGroup(signalName);
    },
    send(message: unknown) {
      proc.send(message);
    },
    onMessage(handler: (message: unknown) => void) {
      messageHandlers.push(handler);
    },
    onExit(handler: (code: number) => void) {
      void proc.exited.then((code) => {
        handler(code);
      });
    },
  };
}
