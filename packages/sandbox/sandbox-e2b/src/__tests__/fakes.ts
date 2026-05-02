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
  readonly runImpl?: (cmd: string, opts: E2bRunOpts | undefined) => Promise<E2bRunResult>;
  readonly killImpl?: () => Promise<void>;
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
      // Production hosted backends MUST advertise this so the adapter can
      // enforce the documented 1 MB output cap server-side; the default
      // fake mirrors that contract so test SDKs don't accidentally exercise
      // the fail-closed branch.
      supportsMaxOutputBytes: true,
      run: async (cmd: string, runOpts?: E2bRunOpts): Promise<E2bRunResult> => {
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
        // The default fake exposes binary-safe methods so the byte-oriented
        // SandboxInstance contract works in tests. Tests that exercise the
        // text-only fallback build their own SDK shape inline.
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
    kill: async (): Promise<void> => {
      if (opts.killImpl !== undefined) {
        await opts.killImpl();
        killed = true;
        return;
      }
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
    supportsTeardown: true,
    createSandbox: async (opts: E2bCreateOpts): Promise<E2bSdkSandbox> => {
      calls.push({ opts });
      return sandbox;
    },
  };
}
