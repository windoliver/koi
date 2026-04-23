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
 *
 * ## Behavior contract — authorization consumers MUST read this
 *
 * After unwrapping, `argv[0]` is the **effective inner command**, not the
 * wrapper. This is intentional: permission rules that match on the command
 * being executed (e.g. "deny `rm -rf` outside workspace") need to see the
 * real command name, not the wrapper.
 *
 * **Wrapper-aware authorization**: if a policy needs to deny commands that
 * run through a specific wrapper (e.g. "deny any command run via `sudo`"),
 * check `cmd.wrappedBy?.includes("sudo")` in addition to or instead of
 * `argv[0]`. The `wrappedBy` field preserves the full chain (outermost first).
 *
 * **Fail-closed guarantee**: when a wrapper's flags cannot be parsed
 * unambiguously, the command is returned unchanged (`argv[0]` stays the
 * wrapper name, `wrappedBy` is absent). Non-execution modes of wrappers
 * (e.g. `sudo -e`, `sudo -l`) also return the original command unchanged.
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
