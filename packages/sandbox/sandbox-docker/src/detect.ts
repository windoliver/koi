export interface DockerAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

export interface DetectOptions {
  readonly probe?: () => Promise<number>;
}

async function defaultProbe(): Promise<number> {
  const proc = Bun.spawn(["docker", "version", "--format", "{{.Server.Version}}"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return await proc.exited;
}

export async function detectDocker(options: DetectOptions = {}): Promise<DockerAvailability> {
  const probe = options.probe ?? defaultProbe;

  try {
    const code = await probe();
    if (code === 0) return { available: true };
    return { available: false, reason: `docker probe exited ${code}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { available: false, reason: `docker probe failed: ${msg}` };
  }
}
