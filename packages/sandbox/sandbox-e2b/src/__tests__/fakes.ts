import type {
  E2bClient,
  E2bCreateOpts,
  E2bRunOpts,
  E2bRunResult,
  E2bSdkSandbox,
} from "../types.js";

export interface FakeRunCall {
  readonly cmd: string;
  readonly opts: E2bRunOpts | undefined;
}

export interface FakeSandbox extends E2bSdkSandbox {
  readonly runCalls: readonly FakeRunCall[];
  readonly files: E2bSdkSandbox["files"] & {
    readonly store: ReadonlyMap<string, string>;
  };
  readonly killed: () => boolean;
}

export interface FakeSandboxOptions {
  readonly runResult?: E2bRunResult;
  readonly runError?: Error;
  readonly initialFiles?: ReadonlyMap<string, string>;
}

export function createFakeSandbox(opts: FakeSandboxOptions = {}): FakeSandbox {
  const runCalls: FakeRunCall[] = [];
  const fileStore = new Map<string, string>(opts.initialFiles ?? []);
  let killed = false;

  return {
    runCalls,
    killed: () => killed,
    commands: {
      run: async (cmd: string, runOpts?: E2bRunOpts): Promise<E2bRunResult> => {
        runCalls.push({ cmd, opts: runOpts });
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
      },
      { store: fileStore },
    ),
    kill: async (): Promise<void> => {
      killed = true;
    },
  };
}

export interface FakeClientCall {
  readonly opts: E2bCreateOpts;
}

export interface FakeClient extends E2bClient {
  readonly calls: readonly FakeClientCall[];
  readonly sandbox: FakeSandbox;
}

export function createFakeClient(sandboxOpts: FakeSandboxOptions = {}): FakeClient {
  const calls: FakeClientCall[] = [];
  const sandbox = createFakeSandbox(sandboxOpts);
  return {
    calls,
    sandbox,
    createSandbox: async (opts: E2bCreateOpts): Promise<E2bSdkSandbox> => {
      calls.push({ opts });
      return sandbox;
    },
  };
}
