import { describe, expect, test } from "bun:test";
import type { SimpleCommand } from "../types.js";
import { applyWrappers } from "./registry.js";

function cmd(argv: readonly string[]): SimpleCommand {
  return { argv, envVars: [], redirects: [], text: argv.join(" ") };
}

describe("applyWrappers", () => {
  test("passes through non-wrapper command unchanged", () => {
    const c = cmd(["rm", "-rf", "/tmp"]);
    expect(applyWrappers(c)).toBe(c);
  });

  test("unwraps nohup", () => {
    const result = applyWrappers(cmd(["nohup", "rm", "-rf", "/tmp"]));
    expect(result.argv).toEqual(["rm", "-rf", "/tmp"]);
    expect(result.wrappedBy).toEqual(["nohup"]);
  });

  test("unwraps timeout with DURATION", () => {
    const result = applyWrappers(cmd(["timeout", "30", "curl", "http://x.com"]));
    expect(result.argv).toEqual(["curl", "http://x.com"]);
    expect(result.wrappedBy).toEqual(["timeout"]);
  });

  test("unwraps sudo -u root", () => {
    const result = applyWrappers(cmd(["sudo", "-u", "root", "ls"]));
    expect(result.argv).toEqual(["ls"]);
    expect(result.wrappedBy).toEqual(["sudo"]);
  });

  test("unwraps env with assignments", () => {
    const result = applyWrappers(cmd(["env", "FOO=bar", "node", "app.js"]));
    expect(result.argv).toEqual(["node", "app.js"]);
    expect(result.wrappedBy).toEqual(["env"]);
    expect(result.envVars).toEqual([{ name: "FOO", value: "bar" }]);
  });

  test("unwraps stdbuf", () => {
    const result = applyWrappers(cmd(["stdbuf", "-o", "L", "grep", "foo"]));
    expect(result.argv).toEqual(["grep", "foo"]);
    expect(result.wrappedBy).toEqual(["stdbuf"]);
  });

  test("unwraps time", () => {
    const result = applyWrappers(cmd(["time", "make"]));
    expect(result.argv).toEqual(["make"]);
    expect(result.wrappedBy).toEqual(["time"]);
  });

  test("unwraps nested wrappers — timeout + nohup", () => {
    const result = applyWrappers(cmd(["timeout", "5", "nohup", "rm", "-rf", "/tmp"]));
    expect(result.argv).toEqual(["rm", "-rf", "/tmp"]);
    expect(result.wrappedBy).toEqual(["timeout", "nohup"]);
  });

  test("unwraps nested — sudo + env with envVars from env layer", () => {
    const result = applyWrappers(cmd(["sudo", "-u", "root", "env", "DEBUG=1", "make", "install"]));
    expect(result.argv).toEqual(["make", "install"]);
    expect(result.wrappedBy).toEqual(["sudo", "env"]);
    expect(result.envVars).toEqual([{ name: "DEBUG", value: "1" }]);
  });

  test("preserves redirects through unwrapping", () => {
    const c: SimpleCommand = {
      argv: ["nohup", "rm", "/tmp/foo"],
      envVars: [],
      redirects: [{ op: ">", target: "/dev/null" }],
      text: "nohup rm /tmp/foo > /dev/null",
    };
    const result = applyWrappers(c);
    expect(result.argv).toEqual(["rm", "/tmp/foo"]);
    expect(result.redirects).toEqual([{ op: ">", target: "/dev/null" }]);
  });

  test("preserves original text through unwrapping", () => {
    const c = cmd(["nohup", "rm", "/tmp"]);
    const result = applyWrappers(c);
    expect(result.text).toBe("nohup rm /tmp");
  });

  test("wrapper with ambiguous parse (refuses) — leaves command untouched", () => {
    const c = cmd(["timeout", "-x", "10", "ls"]);
    expect(applyWrappers(c)).toBe(c);
  });
});
