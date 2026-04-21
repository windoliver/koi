/**
 * Tests for the `--policy-file` YAML/JSON loader.
 *
 * The loader must reject malformed input at startup so `koi start` fails
 * before any model call, matching the gov-10 agent instructions:
 *   "Validate policy-file at parse time; do NOT wait for first tool call
 *    to surface a syntax error."
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicyFile } from "./policy-file.js";

describe("loadPolicyFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-policy-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, contents: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, contents, "utf8");
    return path;
  }

  test("loads a YAML file with a single allow rule", async () => {
    const path = await write(
      "policy.yaml",
      "- match:\n    toolId: add_numbers\n  decision: allow\n",
    );
    const rules = await loadPolicyFile(path);
    expect(rules).toEqual([{ match: { toolId: "add_numbers" }, decision: "allow" }]);
  });

  test("loads a JSON file with multiple rules preserving order", async () => {
    const path = await write(
      "policy.json",
      JSON.stringify([
        { match: { kind: "model_call", model: "anthropic/claude-opus-4-7" }, decision: "allow" },
        { match: { toolId: "web_fetch" }, decision: "deny", severity: "warning" },
      ]),
    );
    const rules = await loadPolicyFile(path);
    expect(rules).toEqual([
      { match: { kind: "model_call", model: "anthropic/claude-opus-4-7" }, decision: "allow" },
      { match: { toolId: "web_fetch" }, decision: "deny", severity: "warning" },
    ]);
  });

  test("preserves optional rule / severity / message fields", async () => {
    const path = await write(
      "policy.yaml",
      `${[
        "- match:",
        "    toolId: shell",
        "  decision: deny",
        "  rule: no-shell",
        "  severity: critical",
        "  message: shell is disabled",
      ].join("\n")}\n`,
    );
    const rules = await loadPolicyFile(path);
    expect(rules).toEqual([
      {
        match: { toolId: "shell" },
        decision: "deny",
        rule: "no-shell",
        severity: "critical",
        message: "shell is disabled",
      },
    ]);
  });

  test("empty list is allowed (no rules)", async () => {
    const path = await write("policy.json", "[]");
    const rules = await loadPolicyFile(path);
    expect(rules).toEqual([]);
  });

  test("rejects missing file", async () => {
    await expect(loadPolicyFile(join(dir, "no-such.yaml"))).rejects.toThrow(/policy-file/);
  });

  test("rejects non-array top-level", async () => {
    const path = await write("bad.yaml", "match:\n  toolId: x\ndecision: allow\n");
    await expect(loadPolicyFile(path)).rejects.toThrow(/array/);
  });

  test("rejects rule missing decision", async () => {
    const path = await write("bad.yaml", "- match:\n    toolId: x\n");
    await expect(loadPolicyFile(path)).rejects.toThrow(/decision/);
  });

  test("rejects invalid decision value", async () => {
    const path = await write("bad.yaml", "- match:\n    toolId: x\n  decision: maybe\n");
    await expect(loadPolicyFile(path)).rejects.toThrow(/decision/);
  });

  test("rejects rule missing match", async () => {
    const path = await write("bad.yaml", "- decision: allow\n");
    await expect(loadPolicyFile(path)).rejects.toThrow(/match/);
  });

  test("rejects invalid kind value", async () => {
    const path = await write("bad.yaml", "- match:\n    kind: probably_not\n  decision: deny\n");
    await expect(loadPolicyFile(path)).rejects.toThrow(/kind/);
  });

  test("accepts custom:<string> kind", async () => {
    const path = await write(
      "policy.yaml",
      "- match:\n    kind: custom:fs_write\n  decision: deny\n",
    );
    const rules = await loadPolicyFile(path);
    expect(rules[0]?.match.kind).toBe("custom:fs_write");
  });

  test("rejects invalid severity value", async () => {
    const path = await write(
      "bad.yaml",
      `${["- match:", "    toolId: x", "  decision: deny", "  severity: bogus"].join("\n")}\n`,
    );
    await expect(loadPolicyFile(path)).rejects.toThrow(/severity/);
  });
});
