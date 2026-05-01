import type {
  DaytonaClient,
  DaytonaCreateOpts,
  DaytonaRunOpts,
  DaytonaRunResult,
  DaytonaSdkSandbox,
} from "../types.js";

export interface FakeRunCall {
  readonly cmd: string;
  readonly opts: DaytonaRunOpts | undefined;
}

export interface FakeSandbox extends DaytonaSdkSandbox {
  readonly runCalls: readonly FakeRunCall[];
  readonly files: DaytonaSdkSandbox["files"] & {
    readonly store: ReadonlyMap<string, string>;
  };
  readonly closed: () => boolean;
  readonly deleted: () => boolean;
}

export interface FakeSandboxOptions {
  readonly runResult?: DaytonaRunResult;
  readonly runError?: Error;
  readonly runImpl?: (cmd: string, opts: DaytonaRunOpts | undefined) => Promise<DaytonaRunResult>;
  readonly closeImpl?: () => Promise<void>;
  readonly deleteImpl?: () => Promise<void>;
  readonly initialFiles?: ReadonlyMap<string, string>;
}

export function createFakeSandbox(opts: FakeSandboxOptions = {}): FakeSandbox {
  const runCalls: FakeRunCall[] = [];
  const fileStore = new Map<string, string>(opts.initialFiles ?? []);
  let closed = false;
  let deleted = false;

  return {
    runCalls,
    closed: () => closed,
    deleted: () => deleted,
    commands: {
      run: async (cmd: string, runOpts?: DaytonaRunOpts): Promise<DaytonaRunResult> => {
        runCalls.push({ cmd, opts: runOpts });
        if (opts.runImpl !== undefined) return opts.runImpl(cmd, runOpts);
        if (opts.runError !== undefined) throw opts.runError;
        return opts.runResult ?? { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
    },
    files: Object.assign(
      {
        read: async (path: string): Promise<string> => {
          const value = fileStore.get(path);
          if (value === undefined) throw new Error(`no such file: ${path}`);
          return value;
        },
        write: async (path: string, content: string): Promise<void> => {
          fileStore.set(path, content);
        },
        readBytes: async (path: string): Promise<Uint8Array> => {
          const value = fileStore.get(path);
          if (value === undefined) throw new Error(`no such file: ${path}`);
          return new TextEncoder().encode(value);
        },
        writeBytes: async (path: string, content: Uint8Array): Promise<void> => {
          fileStore.set(path, new TextDecoder().decode(content));
        },
      },
      { store: fileStore },
    ),
    close: async (): Promise<void> => {
      if (opts.closeImpl !== undefined) {
        await opts.closeImpl();
        closed = true;
        return;
      }
      closed = true;
    },
    // The default fake exposes a delete method so the byte-oriented destroy
    // semantics are exercised; tests that need to verify the close-only
    // fallback build their own SDK shape inline.
    delete: async (): Promise<void> => {
      if (opts.deleteImpl !== undefined) {
        await opts.deleteImpl();
        deleted = true;
        return;
      }
      deleted = true;
    },
  };
}

export interface FakeClientCall {
  readonly opts: DaytonaCreateOpts;
}

export interface FakeClient extends DaytonaClient {
  readonly calls: readonly FakeClientCall[];
  readonly sandbox: FakeSandbox;
}

export function createFakeClient(sandboxOpts: FakeSandboxOptions = {}): FakeClient {
  const calls: FakeClientCall[] = [];
  const sandbox = createFakeSandbox(sandboxOpts);
  return {
    calls,
    sandbox,
    createSandbox: async (opts: DaytonaCreateOpts): Promise<DaytonaSdkSandbox> => {
      calls.push({ opts });
      return sandbox;
    },
  };
}
