import { describe, expect, test } from "bun:test";
import { matchesCommand } from "./dispatch-name.js";

describe("matchesCommand", () => {
  test("matches bare command name", () => {
    expect(matchesCommand("rm", ["rm", "foo"])).toBe(true);
  });

  test("matches absolute path-qualified command", () => {
    expect(matchesCommand("rm", ["/bin/rm", "foo"])).toBe(true);
    expect(matchesCommand("curl", ["/usr/local/bin/curl", "url"])).toBe(true);
  });

  test("REJECTS relative path-qualified command (likely wrapper)", () => {
    expect(matchesCommand("rm", ["./rm", "foo"])).toBe(false);
    expect(matchesCommand("rm", ["./bin/rm", "foo"])).toBe(false);
    expect(matchesCommand("rm", ["../bin/rm", "foo"])).toBe(false);
    expect(matchesCommand("rm", ["bin/rm", "foo"])).toBe(false);
  });

  test("rejects different command", () => {
    expect(matchesCommand("rm", ["ls", "foo"])).toBe(false);
    expect(matchesCommand("rm", ["/bin/ls", "foo"])).toBe(false);
  });

  test("rejects empty argv", () => {
    expect(matchesCommand("rm", [])).toBe(false);
  });

  test("rejects argv[0] === '/' (no basename)", () => {
    expect(matchesCommand("rm", ["/"])).toBe(false);
  });

  test("rejects empty argv[0]", () => {
    expect(matchesCommand("rm", [""])).toBe(false);
  });
});
