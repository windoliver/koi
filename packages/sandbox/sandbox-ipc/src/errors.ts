export class SandboxIpcParseError extends Error {
  readonly path: string;

  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`Invalid sandbox IPC message at ${path}: ${reason}`);
    this.name = "SandboxIpcParseError";
    this.path = path;
    this.reason = reason;
  }
}

export function createSandboxIpcParseError(path: string, reason: string): SandboxIpcParseError {
  return new SandboxIpcParseError(path, reason);
}
