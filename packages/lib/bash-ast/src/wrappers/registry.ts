import type { SimpleCommand } from "../types.js";
import { unwrapEnv } from "./env.js";
import { unwrapNohup } from "./nohup.js";
import { unwrapStdbuf } from "./stdbuf.js";
import { unwrapSudo } from "./sudo.js";
import { unwrapTime } from "./time.js";
import { unwrapTimeout } from "./timeout.js";
import type { EnvVar, UnwrapResult } from "./types.js";

type Unwrapper = (argv: readonly string[]) => UnwrapResult | null;

const WRAPPERS: ReadonlyMap<string, Unwrapper> = new Map([
  ["nohup", unwrapNohup],
  ["timeout", unwrapTimeout],
  ["sudo", unwrapSudo],
  ["env", unwrapEnv],
  ["stdbuf", unwrapStdbuf],
  ["time", unwrapTime],
]);

/**
 * Iteratively unwrap wrapper commands (`nohup`, `timeout`, `sudo`, `env`,
 * `stdbuf`, `time`) from a `SimpleCommand`, recording the wrapper chain in
 * `wrappedBy`. Returns the original command unchanged when no wrappers apply.
 * Stops immediately if a wrapper's flag parse is ambiguous (`null` return).
 */
export function applyWrappers(cmd: SimpleCommand): SimpleCommand {
  let current = cmd;
  const chain: string[] = [];
  const extraEnvVars: EnvVar[] = [];

  for (;;) {
    const name = current.argv[0];
    if (name === undefined) break;
    const unwrapper = WRAPPERS.get(name);
    if (unwrapper === undefined) break;
    const result = unwrapper(current.argv);
    if (result === null) break;
    chain.push(name);
    for (const ev of result.envVars) extraEnvVars.push(ev);
    current = {
      argv: result.argv,
      envVars: current.envVars,
      redirects: current.redirects,
      text: current.text,
    };
  }

  if (chain.length === 0) return cmd;

  return {
    argv: current.argv,
    envVars: extraEnvVars.length > 0 ? [...cmd.envVars, ...extraEnvVars] : cmd.envVars,
    redirects: cmd.redirects,
    text: cmd.text,
    wrappedBy: chain,
  };
}
