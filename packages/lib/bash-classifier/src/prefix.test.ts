import { describe, expect, test } from "bun:test";
import { ARITY } from "./arity.js";
import { prefix } from "./prefix.js";

describe("prefix", () => {
  test("returns empty string for empty tokens", () => {
    expect(prefix([])).toBe("");
  });

  test("returns the binary name for unknown commands (arity 1 default)", () => {
    expect(prefix(["unknown"])).toBe("unknown");
    expect(prefix(["unknown", "sub", "arg"])).toBe("unknown");
  });

  test("respects single-token ARITY entries", () => {
    // git has arity 2
    expect(prefix(["git", "push", "origin"])).toBe("git push");
    expect(prefix(["git", "status"])).toBe("git status");
  });

  test("respects multi-token ARITY keys over the base binary arity", () => {
    // `npm` has arity 2, but `npm run` has arity 3 — the longer key wins
    expect(prefix(["npm", "run", "build"])).toBe("npm run build");
    // `docker` arity 2, `docker compose` arity 3
    expect(prefix(["docker", "compose", "up", "-d"])).toBe("docker compose up");
  });

  test("falls back to base-binary arity when the multi-token key does not match", () => {
    // `npm install` is not a multi-token ARITY entry — base `npm` arity 2 wins
    expect(prefix(["npm", "install", "left-pad"])).toBe("npm install");
  });

  test("returns all tokens when the command is shorter than its declared arity", () => {
    // `npm run` declared arity 3 but only 2 tokens present
    expect(prefix(["npm", "run"])).toBe("npm run");
    // `docker compose` declared arity 3 but only 2 tokens present
    expect(prefix(["docker", "compose"])).toBe("docker compose");
  });

  test("single-token commands with arity 1 (e.g. `ls`) return the binary", () => {
    expect(prefix(["ls", "-la", "/tmp"])).toBe("ls");
    expect(prefix(["cat", "file.txt"])).toBe("cat");
  });

  test("ARITY entries are self-consistent", () => {
    // Every arity value is >= 1 and <= the number of tokens in the key
    for (const [key, arity] of Object.entries(ARITY)) {
      const tokenCount = key.split(" ").length;
      expect(arity).toBeGreaterThanOrEqual(tokenCount);
      expect(arity).toBeGreaterThanOrEqual(1);
    }
  });
});
